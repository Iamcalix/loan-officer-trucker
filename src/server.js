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
import { loadRegister, matchCandidates, registerSize, customerByPlate } from './register.js';
import { saveAssignments, setAssignmentPlate, setComment, getAssignments, assignedPlatesForDay } from './assignments.js';
import { sampleFromRows, getVisits, getExtras } from './visitlog.js';
import { officePlace, haversineM } from './places.js';
import { analyzeTrack } from './visits.js';
import { buildReport, writeReportFiles, listReports, eatToday } from './report.js';
import { startReportScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const gps = createFleetClient();

// ---- live snapshot: bulk positions + device names, merged & cached briefly ----
let snapCache = { at: 0, data: null, promise: null };
let deviceNames = { at: 0, map: new Map() };

// imei -> freshest KNOWN last-GPS-fix time (epoch ms), unioned across every roster
// and live read. Timestamps only ever move FORWARD, so a transient platform failure
// simply fails to update an entry rather than erasing it — a bike never flips to
// "GPS offline" just because one fetch hiccuped. Feeds the day report's can't-verify
// classification.
const deviceLastFix = new Map();
function rememberFix(imei, fixMs) {
  if (!imei || !Number.isFinite(fixMs) || fixMs <= 0) return;
  const prev = deviceLastFix.get(imei);
  if (prev == null || fixMs > prev) deviceLastFix.set(imei, fixMs);
}

// imei -> freshest KNOWN heartbeat (epoch ms): the last time the DEVICE talked to
// the platform, whether or not it produced a GPS position. This is the platform's
// "online" signal. Same forward-only union as deviceLastFix.
const deviceLastSeen = new Map();
function rememberSeen(imei, heartMs) {
  if (!imei || !Number.isFinite(heartMs) || heartMs <= 0) return;
  const prev = deviceLastSeen.get(imei);
  if (prev == null || heartMs > prev) deviceLastSeen.set(imei, heartMs);
}

async function getDeviceNames() {
  // Names change rarely; refresh at most every 5 min.
  if (deviceNames.map.size && Date.now() - deviceNames.at < 5 * 60_000) return deviceNames.map;
  const list = await gps.listDevices();
  // MERGE into the existing roster (never replace). A refresh can transiently
  // return fewer devices if a platform/sub-account call fails; overwriting would
  // make bikes vanish from the picker. Union keeps every bike once seen.
  for (const d of list) {
    deviceNames.map.set(d.imei, d.name);
    // 18gps rosters carry each tracker's last GPS fix even when it has no current
    // position — the authoritative "is this bike's GPS alive" signal — plus its last
    // heartbeat (device-online) time.
    rememberFix(d.imei, d.lastFixMs);
    rememberSeen(d.imei, d.lastHeartMs);
  }
  deviceNames.at = Date.now();
  return deviceNames.map;
}

// Reverse index: normalized plate -> [imei, ...] (a plate can have >1 tracker),
// rebuilt whenever the device-name cache changes. Lets a register plate resolve to
// its live tracker(s).
// Canonical plate key: strip punctuation AND a trailing tracker-index digit
// (Wanway/18gps name a bike's two trackers "MC693FML [1]" / "[2]"; real plates end
// in letters, so trailing digits after a letter are always the tracker index).
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
let plateIndex = { at: 0, map: new Map() };
async function getPlateIndex() {
  const names = await getDeviceNames();
  if (plateIndex.at === deviceNames.at && plateIndex.map.size) return plateIndex.map;
  const map = new Map();
  for (const [imei, name] of names) {
    const p = normPlate(name);
    if (!p) continue;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(imei);
  }
  plateIndex = { at: deviceNames.at, map };
  return map;
}

// Cache the bulk position read so the live map and the customer geofence share
// one call.
let locCache = { at: 0, data: null };
async function getLiveLocations() {
  if (locCache.data && Date.now() - locCache.at < config.liveCacheMs) return locCache.data;
  const data = await gps.liveLocations();
  // A live position IS a fresh GPS fix — fold it into the freshest-fix memory so
  // Wanway bikes (whose roster has no fix time) and any just-reported 18gps bike are
  // covered. ageSec null = fix time unknown but present → treat as "now".
  const now = Date.now();
  for (const l of data) rememberFix(l.imei, l.ageSec == null ? now : now - l.ageSec * 1000);
  locCache = { at: now, data };
  return data;
}

// Each officer's set of assigned follow-list plates for the day.
async function assignedPlatesByOfficer(day) {
  const rows = await getAssignments(day).catch(() => []);
  const map = new Map();
  for (const r of rows) {
    if (!r.plate) continue;
    if (!map.has(r.officerImei)) map.set(r.officerImei, new Set());
    map.get(r.officerImei).add(normPlate(r.plate));
  }
  return map;
}

// Where is this officer? The office, or the nearest CUSTOMER bike within range —
// preferring one of THEIR assigned customers, else flagging it as unassigned.
// (Office wins first and is never reported as a "meeting".)
function placeFor(officerPos, customerBikes, assignedSet) {
  const R = config.proximity.customerRadiusM;              // assigned: lenient
  const Ru = config.proximity.unassignedRadiusM;           // unassigned: tight (sensitive)
  let bestA = null, bestU = null;
  for (const c of customerBikes) {
    const d = haversineM(officerPos, c);
    if (assignedSet.has(c.plate)) { if (d <= R && (!bestA || d < bestA.d)) bestA = { d, plate: c.plate, name: c.name, speed: c.speed }; }
    else if (d <= Ru && (!bestU || d < bestU.d)) bestU = { d, plate: c.plate, name: c.name, speed: c.speed };
  }
  // An ASSIGNED customer is counted even at the office — a customer who comes to the
  // office to meet their officer is still a visit.
  if (bestA) return { type: 'customer', plate: bestA.plate, name: bestA.name, assigned: true, distM: Math.round(bestA.d), custSpeed: bestA.speed };
  // Otherwise the office takes precedence, and an UNASSIGNED customer is NEVER
  // reported at the office (only out in the field).
  const office = officePlace();
  if (office) {
    const d = haversineM(officerPos, office);
    if (d <= office.radiusM) return { type: 'office', name: office.name, distM: Math.round(d) };
  }
  if (bestU) return { type: 'customer', plate: bestU.plate, name: bestU.name, assigned: false, distM: Math.round(bestU.d), custSpeed: bestU.speed };
  return null;
}

// Live status label from a fix + optional real-time status.
function liveLabel(place, st) {
  if (st && st.online === false) return { state: 'offline', text: 'Offline' };
  if (place?.type === 'office') return { state: 'office', text: `At ${place.name}` };
  if (place?.type === 'customer') return { state: 'customer', text: `With ${place.name}${place.assigned ? '' : ' (unassigned)'}` };
  const moving = st && st.speedKmh != null && st.speedKmh > config.proximity.movingSpeedKmh;
  if (moving) return { state: 'moving', text: `Moving ${Math.round(st.speedKmh)} km/h` };
  return { state: 'stopped', text: 'Stopped (no known place)' };
}

async function buildSnapshot() {
  const [locs, names] = await Promise.all([getLiveLocations(), getDeviceNames().catch(() => new Map())]);
  const roster = officerImeis();
  const restrict = roster.size > 0;
  let rows = restrict ? locs.filter((l) => roster.has(l.imei)) : [];

  // Assigned plates per officer, and every customer bike (non-officer) with its
  // plate + register name — so we can tell WHOM an officer is with, assigned or not.
  const assignedByOff = restrict ? await assignedPlatesByOfficer(eatToday()).catch(() => new Map()) : new Map();
  const customerBikes = restrict
    ? locs.filter((l) => !roster.has(l.imei)).map((l) => {
        const plate = normPlate(names.get(l.imei) || '');
        return plate ? { lat: l.lat, lng: l.lng, speed: l.speed ?? null, plate, name: customerByPlate(plate)?.name || names.get(l.imei) || l.imei } : null;
      }).filter(Boolean)
    : [];

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

  const snapshot = rows.map((l) => {
    const o = officerFor(l.imei);
    const place = placeFor(l, customerBikes, assignedByOff.get(l.imei) || new Set());
    const st = statusByImei.get(l.imei) || null;
    return {
      imei: l.imei,
      name: o?.name || names.get(l.imei) || l.imei,
      phone: o?.phone || null,
      area: o?.area || null,
      lat: l.lat,
      lng: l.lng,
      place: place ? { type: place.type, name: place.name, plate: place.plate || null, assigned: place.assigned !== false, distM: place.distM, custSpeed: place.custSpeed ?? null } : null,
      status: liveLabel(place, st),
      online: st ? st.online : null,
      speedKmh: st ? st.speedKmh : null,
      ageSec: st ? st.ageSec : null,
      // Age of the officer's own GPS fix — how the visit sampler knows the position
      // is live, not a stale echo from a parked tracker. Live feed always carries it;
      // fall back to the status call.
      fixAgeSec: l.ageSec != null ? l.ageSec : (st ? st.ageSec : null),
      assignedCount: (assignedByOff.get(l.imei) || new Set()).size,
    };
  });

  // Log live proximity so "customers met" works for BOTH platforms (no history
  // API needed), then attach each officer's running count of customers met today.
  const now = Math.floor(Date.now() / 1000);
  await sampleFromRows(snapshot, now).catch(() => {});
  const met = await metTodayMap().catch(() => new Map());
  for (const s of snapshot) {
    const aset = assignedByOff.get(s.imei) || new Set();
    // Count an assigned customer on any real stop; an unassigned one only when it
    // clears the high-confidence bar (long stay).
    const counted = (met.get(s.imei) || []).filter((v) => aset.has(normPlate(v.plate || v.name)) || v.minutes >= config.proximity.unassignedMinMinutes);
    s.metToday = counted.length;
    s.withCustomersMinToday = counted.reduce((sum, x) => sum + x.minutes, 0);
  }
  return snapshot;
}

// Cache of today's logged visits (officerImei -> [visit,...]) for the live badge.
let todVisits = { at: 0, day: null, map: new Map() };
async function metTodayMap() {
  const day = eatToday();
  if (todVisits.day === day && Date.now() - todVisits.at < 30_000) return todVisits.map;
  const map = await getVisits(day);
  todVisits = { at: Date.now(), day, map };
  return map;
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

// Build the per-agent follow-list report. Shared by the endpoint and the nightly
// scheduler.
async function makeReport(date) {
  // Group the day's follow-list assignments by officer so the report can show
  // visited vs not-visited per officer.
  const rows = await getAssignments(date).catch(() => []);
  const byOfficer = new Map();
  for (const r of rows) {
    if (!byOfficer.has(r.officerImei)) byOfficer.set(r.officerImei, []);
    byOfficer.get(r.officerImei).push(r);
  }
  const [visitsByOfficer, extrasByOfficer, locs, names] = await Promise.all([
    getVisits(date).catch(() => new Map()),
    getExtras(date).catch(() => new Map()),
    getLiveLocations().catch(() => []),
    getDeviceNames().catch(() => new Map()),
  ]);
  // (getLiveLocations + getDeviceNames above have just refreshed the freshest-fix
  // memory for every tracker they saw.) A plate is "trackable" if ANY of its
  // trackers fixed GPS within the verify window — judged from the freshest KNOWN fix
  // (roster last-fix ∪ live feed), NOT a single live snapshot. So a bike whose current
  // position was dropped from the live feed, or that a transient platform failure
  // missed, is not wrongly flagged. A not-visited assigned customer whose bike is
  // trackable = a real miss; one whose bike was DARK all day = "can't verify".
  void locs;
  const now = Date.now();
  const fixWindowMs = config.gpsVerifyWindowMin * 60_000;
  const seenWindowMs = config.deviceSeenWindowMin * 60_000;
  const onlinePlates = new Set();
  const addIfPlate = (imei) => { const p = normPlate(names.get(imei) || ''); if (p) onlinePlates.add(p); };
  // Trackable if the tracker fixed GPS within the verify window (position is fresh)…
  for (const [imei, fixMs] of deviceLastFix) if (now - fixMs <= fixWindowMs) addIfPlate(imei);
  // …OR its DEVICE is simply still connected (recent heartbeat) — the platform's own
  // "online" light. A parked bike stays online (heartbeat) with a frozen position, so
  // it must NOT read "GPS offline". Any one live tracker makes the whole bike online.
  for (const [imei, heartMs] of deviceLastSeen) if (now - heartMs <= seenWindowMs) addIfPlate(imei);
  return buildReport(gps, date, byOfficer, visitsByOfficer, extrasByOfficer, onlinePlates);
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
      // Only the assigned follow-list customers for the day, at their bikes' current
      // positions — the app now focuses on those, not the whole fleet.
      const day = url.searchParams.get('day') || eatToday();
      const [assigned, plateIdx, locs] = await Promise.all([
        assignedPlatesForDay(day).catch(() => new Map()),
        getPlateIndex().catch(() => new Map()),
        getLiveLocations().catch(() => []),
      ]);
      const liveByImei = new Map(locs.map((l) => [l.imei, l]));
      const list = [];
      for (const [plate, officerImeisForPlate] of assigned) {
        let pos = null;
        for (const im of (plateIdx.get(plate) || [])) { const l = liveByImei.get(im); if (l) { pos = l; break; } }
        if (!pos) continue; // can't place a customer whose bike isn't reporting now
        list.push({
          plate, name: customerByPlate(plate)?.name || plate,
          lat: pos.lat, lng: pos.lng, assigned: true,
          assignedTo: officerImeisForPlate.map((im) => officerFor(im)?.name || im),
        });
      }
      return sendJson(res, 200, { count: list.length, assignedCount: list.length, customers: list });
    }

    // Register search — fuzzy name matches for the manual-map UI / autocomplete.
    if (p === '/api/register/search') {
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 8, 25);
      return sendJson(res, 200, { size: registerSize(), matches: q ? matchCandidates(q, limit) : [] });
    }

    // Force an immediate reload of the customer register from Supabase (after a
    // bulk import) instead of waiting for the periodic refresh.
    if (p === '/api/register/reload' && req.method === 'POST') {
      const list = await loadRegister();
      return sendJson(res, 200, { ok: true, size: list.length });
    }

    // Save a per-customer note: { day?, officerImei, enteredName, comment }.
    if (p === '/api/assignments/comment' && req.method === 'POST') {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const day = payload.day || eatToday();
      const officerImei = String(payload.officerImei || '');
      if (!/^\d{6,}$/.test(officerImei) || !payload.enteredName) return sendJson(res, 400, { error: 'officerImei + enteredName required' });
      await setComment(day, officerImei, String(payload.enteredName), payload.comment || '');
      return sendJson(res, 200, { ok: true });
    }

    // Import an officer's daily follow-list: { officerImei, names:[...], day? }.
    if (p === '/api/assignments' && req.method === 'POST') {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const officerImei = String(payload.officerImei || '');
      if (!/^\d{6,}$/.test(officerImei)) return sendJson(res, 400, { error: 'valid officerImei required' });
      const day = payload.day || eatToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: 'bad day' });
      const names = Array.isArray(payload.names) ? payload.names
        : String(payload.names || '').split(/[\n,;]+/); // accept a pasted block too
      const result = await saveAssignments(day, officerImei, names);
      snapCache = { at: 0, data: null, promise: null };
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Manually map one unmatched name to a plate: { day?, officerImei, enteredName, plate }.
    if (p === '/api/assignments/map' && req.method === 'POST') {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const day = payload.day || eatToday();
      const officerImei = String(payload.officerImei || '');
      if (!/^\d{6,}$/.test(officerImei) || !payload.enteredName) return sendJson(res, 400, { error: 'officerImei + enteredName required' });
      await setAssignmentPlate(day, officerImei, String(payload.enteredName), payload.plate || null);
      snapCache = { at: 0, data: null, promise: null };
      return sendJson(res, 200, { ok: true });
    }

    // Today's (or ?day=) follow-list grouped per officer, with match status.
    if (p === '/api/assignments') {
      const day = url.searchParams.get('day') || eatToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: 'bad day' });
      const rows = await getAssignments(day);
      const byOfficer = new Map();
      for (const r of rows) {
        if (!byOfficer.has(r.officerImei)) {
          const o = officerFor(r.officerImei);
          byOfficer.set(r.officerImei, { officerImei: r.officerImei, officer: o?.name || r.officerImei, items: [] });
        }
        byOfficer.get(r.officerImei).items.push(r);
      }
      return sendJson(res, 200, { day, officers: [...byOfficer.values()] });
    }

    // /api/officers/:imei/history?hours=8  (or ?start=&end= unix seconds)
    const hist = p.match(/^\/api\/officers\/([^/]+)\/history$/);
    if (hist) {
      const imei = decodeURIComponent(hist[1]);
      const now = Math.floor(Date.now() / 1000);
      const hours = Number(url.searchParams.get('hours'));
      const start = Number(url.searchParams.get('start')) || now - (Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600;
      const end = Number(url.searchParams.get('end')) || now;
      const [points, status, loc, dayVisits, plateIdx, locs] = await Promise.all([
        gps.history(imei, start, end).catch(() => []), // a history failure must not 502 the whole view
        gps.status(imei).catch(() => null),
        gps.location(imei).catch(() => null),
        getVisits(eatToday()).catch(() => new Map()),
        getPlateIndex().catch(() => new Map()),
        getLiveLocations().catch(() => []),
      ]);
      const analysis = analyzeTrack(points);
      // "Customers met" must match the sidebar/report → use the live visit log,
      // NOT the history analysis (18gps has no history; Wanway history under-counts).
      // Attach each met customer's current position so the map can pin the visits
      // even when there's no GPS route (18gps). The route line + stop markers still
      // come from history (best-effort, Wanway only).
      const liveByImei = new Map(locs.map((l) => [l.imei, l]));
      const visits = (dayVisits.get(imei) || []).map((v) => {
        // Prefer the location logged at the moment of the visit; only older rows
        // (before we stored it) fall back to the customer's current position.
        if (Number.isFinite(v.lat) && Number.isFinite(v.lng)) return v;
        let pos = null;
        for (const im of (plateIdx.get(v.plate) || [])) { const l = liveByImei.get(im); if (l) { pos = l; break; } }
        return { ...v, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null };
      });
      return sendJson(res, 200, {
        imei, start, end, status, current: loc,
        count: points.length, points,
        stops: analysis.stops,
        visits,
        officeMinutes: analysis.officeMinutes,
        unexplained: analysis.unexplained,
        visitSource: 'live',
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
// Seed the officer roster + customer register from durable storage (Supabase)
// before serving, then refresh periodically so edits elsewhere are picked up.
await initRoster();
await loadRegister().then((r) => console.log(`customer register loaded: ${r.length} customers`)).catch((e) => console.error('register load failed:', e.message));
setInterval(() => { initRoster().catch(() => {}); }, 60_000).unref();
setInterval(() => { loadRegister().catch(() => {}); }, 10 * 60_000).unref();

server.listen(config.port, () => {
  console.log(`officer-tracker listening on http://localhost:${config.port}`);
  // Warm the fleet caches right away so the first user click after a cold start
  // (Render free dynos sleep when idle) isn't a slow read that can time out.
  Promise.allSettled([getDeviceNames(), getLiveLocations()])
    .then(() => console.log('fleet caches warmed'))
    .catch(() => {});
});

// Nightly end-of-day report → saved file in the reports dir.
startReportScheduler(async (date) => {
  const report = await makeReport(date);
  writeReportFiles(report);
  return report;
});
