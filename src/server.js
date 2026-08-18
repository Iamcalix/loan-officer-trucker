// Zero-dependency HTTP server: serves the map UI and a small JSON API backed by
// the read-only Wanway client. Node 18+ (global fetch) — no npm install needed.

import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfigured } from './config.js';
import { createFleetClient } from './fleet.js';
import { officerFor, officerImeis, hasRoster, saveRoster, initRoster } from './officers.js';
import { classify, officePlace, customerCount, setLiveCustomers } from './places.js';
import { analyzeTrack } from './visits.js';
import { buildReport, writeReportFiles, listReports, eatToday } from './report.js';
import { startReportScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const gps = createFleetClient();

// ---- live snapshot: bulk positions + device names, merged & cached briefly ----
let snapCache = { at: 0, data: null, promise: null };
let deviceNames = { at: 0, map: new Map() };

async function getDeviceNames() {
  // Names change rarely; refresh at most every 5 min.
  if (deviceNames.map.size && Date.now() - deviceNames.at < 5 * 60_000) return deviceNames.map;
  const list = await gps.listDevices();
  // MERGE into the existing roster (never replace). A refresh can transiently
  // return fewer devices if a platform/sub-account call fails; overwriting would
  // make bikes vanish from the picker. Union keeps every bike once seen.
  for (const d of list) deviceNames.map.set(d.imei, d.name);
  deviceNames.at = Date.now();
  return deviceNames.map;
}

// Cache the bulk position read so the live map and the customer geofence share
// one call.
let locCache = { at: 0, data: null };
async function getLiveLocations() {
  if (locCache.data && Date.now() - locCache.at < config.liveCacheMs) return locCache.data;
  const data = await gps.liveLocations();
  locCache = { at: Date.now(), data };
  return data;
}

// Customer location source = the customers' OWN bike trackers. Every tracked
// device that is NOT a field officer is treated as a customer at its current
// bike position, so "met the customer" = officer's tracker within range of the
// customer's bike. Requires a roster (otherwise every unit would be a customer).
async function refreshCustomerGeofence() {
  const roster = officerImeis();
  if (roster.size === 0) { setLiveCustomers([]); return; }
  const [locs, names] = await Promise.all([getLiveLocations(), getDeviceNames().catch(() => new Map())]);
  setLiveCustomers(
    locs.filter((l) => !roster.has(l.imei))
      .map((l) => ({ id: l.imei, name: names.get(l.imei) || l.imei, lat: l.lat, lng: l.lng })),
  );
}

// Live status label from a fix + optional real-time status.
function liveLabel(place, st) {
  if (st && st.online === false) return { state: 'offline', text: 'Offline' };
  if (place?.type === 'office') return { state: 'office', text: `At ${place.name}` };
  if (place?.type === 'customer') return { state: 'customer', text: `With ${place.name}` };
  const moving = st && st.speedKmh != null && st.speedKmh > config.proximity.movingSpeedKmh;
  if (moving) return { state: 'moving', text: `Moving ${Math.round(st.speedKmh)} km/h` };
  return { state: 'stopped', text: 'Stopped (no known place)' };
}

async function buildSnapshot() {
  await refreshCustomerGeofence();
  const [locs, names] = await Promise.all([getLiveLocations(), getDeviceNames().catch(() => new Map())]);
  const roster = officerImeis();
  // Officers are ONLY the roster bikes. Every other bike is a customer (served
  // separately via /api/customers), so before the roster is set this list is empty.
  const restrict = roster.size > 0;
  let rows = restrict ? locs.filter((l) => roster.has(l.imei)) : [];

  // With a (small) roster we can afford one live status call each, so we can tell
  // moving vs stopped and online vs offline. Without a roster we skip that.
  const statusByImei = new Map();
  if (restrict && rows.length <= 80) {
    const CONC = 8;
    for (let i = 0; i < rows.length; i += CONC) {
      const batch = rows.slice(i, i + CONC);
      const res = await Promise.all(batch.map((r) => gps.status(r.imei).then((s) => [r.imei, s]).catch(() => null)));
      res.forEach((pair) => { if (pair) statusByImei.set(pair[0], pair[1]); });
    }
  }

  return rows.map((l) => {
    const o = officerFor(l.imei);
    const place = classify(l);
    const st = statusByImei.get(l.imei) || null;
    return {
      imei: l.imei,
      name: o?.name || names.get(l.imei) || l.imei,
      phone: o?.phone || null,
      area: o?.area || null,
      lat: l.lat,
      lng: l.lng,
      place: place ? { type: place.type, name: place.name, distM: Math.round(place.distM) } : null,
      status: liveLabel(place, st),
      online: st ? st.online : null,
      speedKmh: st ? st.speedKmh : null,
      ageSec: st ? st.ageSec : null,
    };
  });
}

async function getSnapshot() {
  if (snapCache.data && Date.now() - snapCache.at < config.liveCacheMs) return snapCache.data;
  // Collapse concurrent refreshes into one in-flight request.
  if (!snapCache.promise) {
    snapCache.promise = buildSnapshot()
      .then((data) => { snapCache = { at: Date.now(), data, promise: null }; return data; })
      .catch((e) => { snapCache.promise = null; throw e; });
  }
  return snapCache.promise;
}

// Build a report, refreshing the customer geofence first. Shared by the endpoint
// and the nightly scheduler.
async function makeReport(date) {
  await refreshCustomerGeofence();
  return buildReport(gps, date);
}

// -------------------------------- routing ------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2_000_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function sendReportsIndex(res) {
  const dates = listReports();
  const items = dates.length
    ? dates.map((d) => `<li><a href="/reports/report-${d}.html">${d}</a> · <a href="/reports/report-${d}.json">json</a></li>`).join('')
    : '<li class="muted">No reports saved yet — they generate automatically each evening.</li>';
  const html = `<!doctype html><meta charset="utf-8"><title>Saved reports</title>
    <style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;max-width:640px;margin:40px auto;padding:0 20px}
    a{color:#93c5fd} li{margin:6px 0} .muted{color:#94a3b8} h1{font-size:18px}</style>
    <h1>Saved day reports</h1><p><a href="/">← Live map</a></p><ul>${items}</ul>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function serveReportFile(res, name) {
  if (!/^report-\d{4}-\d{2}-\d{2}\.(html|json)$/.test(name)) return sendJson(res, 404, { error: 'not found' });
  const file = path.join(path.resolve(config.reportsDir), name);
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') return sendJson(res, 200, { ok: true, now: Math.floor(Date.now() / 1000) });

    if (p === '/api/officers') {
      const data = await getSnapshot();
      return sendJson(res, 200, { count: data.length, officers: data, hasRoster: hasRoster() });
    }

    // All bikes, each flagged whether it is currently a field officer — feeds the
    // "Manage officers" picker. Based on the FULL device roster (both platforms),
    // NOT just live-positioned bikes, so a momentarily-offline tracker can still be
    // picked as an officer and every bike is selectable.
    if (p === '/api/devices') {
      const roster = officerImeis();
      const [names, locs] = await Promise.all([
        getDeviceNames().catch(() => new Map()),
        getLiveLocations().catch(() => []),
      ]);
      const hasFix = new Set(locs.map((l) => l.imei));
      const list = [...names.entries()].map(([imei, name]) => {
        const o = officerFor(imei);
        return { imei, name: name || imei, isOfficer: roster.has(imei), officer: o || null, online: hasFix.has(imei) };
      }).sort((a, b) => (b.isOfficer - a.isOfficer) || String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { count: list.length, devices: list });
    }

    // Save the officer roster (replaces it wholesale).
    if (p === '/api/roster' && req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const src = payload.officers || {};
      const clean = {};
      for (const [imei, v] of Object.entries(src)) {
        if (!/^\d{6,}$/.test(String(imei))) continue;
        clean[imei] = {
          name: (String(v?.name || '').trim() || imei).slice(0, 60),
          area: String(v?.area || '').trim().slice(0, 60),
          phone: String(v?.phone || '').trim().slice(0, 30),
        };
      }
      await saveRoster(clean);
      snapCache = { at: 0, data: null, promise: null }; // rebuild officers on next read
      return sendJson(res, 200, { ok: true, count: Object.keys(clean).length });
    }

    if (p === '/api/customers') {
      // Every bike that is NOT a loan officer, at its current position.
      const roster = officerImeis();
      const [locs, names] = await Promise.all([getLiveLocations(), getDeviceNames().catch(() => new Map())]);
      const list = locs
        .filter((l) => !roster.has(l.imei))
        .map((l) => ({ imei: l.imei, name: names.get(l.imei) || l.imei, lat: l.lat, lng: l.lng }));
      return sendJson(res, 200, { count: list.length, customers: list });
    }

    // /api/officers/:imei/history?hours=8  (or ?start=&end= unix seconds)
    const hist = p.match(/^\/api\/officers\/([^/]+)\/history$/);
    if (hist) {
      const imei = decodeURIComponent(hist[1]);
      const now = Math.floor(Date.now() / 1000);
      const hours = Number(url.searchParams.get('hours'));
      const start = Number(url.searchParams.get('start')) || now - (Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600;
      const end = Number(url.searchParams.get('end')) || now;
      await refreshCustomerGeofence();
      const [points, status, loc] = await Promise.all([
        gps.history(imei, start, end),
        gps.status(imei).catch(() => null),
        gps.location(imei).catch(() => null),
      ]);
      const analysis = analyzeTrack(points);
      return sendJson(res, 200, {
        imei, start, end, status, current: loc,
        count: points.length, points,
        stops: analysis.stops,
        visits: analysis.visits,
        officeMinutes: analysis.officeMinutes,
        unexplained: analysis.unexplained,
      });
    }

    // End-of-day report: per-officer whereabouts + customers met + durations.
    // ?date=YYYY-MM-DD (East Africa Time day). Defaults to today (EAT).
    if (p === '/api/report') {
      const date = url.searchParams.get('date') || eatToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'bad date (use YYYY-MM-DD)' });
      return sendJson(res, 200, await makeReport(date));
    }

    // List generated report files, and let one be (re)generated on demand.
    if (p === '/api/reports') {
      return sendJson(res, 200, { dates: listReports() });
    }
    if (p === '/api/reports/generate' && req.method === 'POST') {
      const body = await readBody(req);
      let payload = {}; try { payload = JSON.parse(body || '{}'); } catch { /* */ }
      const date = payload.date || eatToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'bad date' });
      const report = await makeReport(date);
      const { htmlPath } = writeReportFiles(report);
      return sendJson(res, 200, { ok: true, date, officers: report.count, file: path.basename(htmlPath) });
    }

    if (p === '/api/places') {
      // Feed the map the office marker + geofence radii.
      return sendJson(res, 200, {
        office: officePlace(),
        customerRadiusM: config.proximity.customerRadiusM,
        customerCount: customerCount(),
        hasRoster: hasRoster(),
      });
    }

    if (p === '/api/officers/status') {
      // ?imei=... single-device live status (online/acc/speed/age)
      const imei = url.searchParams.get('imei');
      if (!imei) return sendJson(res, 400, { error: 'imei required' });
      return sendJson(res, 200, await gps.status(imei));
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

    // Saved report files (from the reports dir, not public/).
    if (p === '/reports' || p === '/reports/') return sendReportsIndex(res);
    if (p.startsWith('/reports/')) return serveReportFile(res, p.slice('/reports/'.length));

    return serveStatic(res, p);
  } catch (e) {
    return sendJson(res, 502, { error: String(e.message || e) });
  }
});

assertConfigured();
// Seed the officer roster from durable storage (Supabase) before serving, then
// refresh it periodically so a roster edited elsewhere is picked up.
await initRoster();
setInterval(() => { initRoster().catch(() => {}); }, 60_000).unref();

server.listen(config.port, () => {
  console.log(`officer-tracker listening on http://localhost:${config.port}`);
});

// Nightly end-of-day report → saved file in the reports dir.
startReportScheduler(async (date) => {
  const report = await makeReport(date);
  writeReportFiles(report);
  return report;
});
