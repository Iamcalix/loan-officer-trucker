// Builds the end-of-day report (data + a self-contained HTML file). Shared by
// the /api/report endpoint and the nightly file generator so both produce
// identical output.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { officerFor, officerImeis } from './officers.js';
import { analyzeTrack } from './visits.js';
import { haversineM } from './places.js';

// Today's date (YYYY-MM-DD) in East Africa Time (UTC+3), independent of server TZ.
export function eatToday() {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}
export function eatYesterday() {
  return new Date(Date.now() + 3 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}

function dayBounds(date) {
  const start = Math.floor(new Date(`${date}T00:00:00+03:00`).getTime() / 1000);
  return { start, end: start + 24 * 3600 };
}

function trackKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversineM(points[i - 1], points[i]);
  return Math.round(m / 100) / 10;
}

async function officerDay(gps, imei, start, end) {
  const o = officerFor(imei);
  const points = await gps.history(imei, start, end);
  const a = analyzeTrack(points);
  const timeline = a.stops
    .map((s) => ({
      start: s.start, end: s.end, minutes: s.minutes,
      type: s.place?.type || 'unknown', name: s.place?.name || null, lat: s.lat, lng: s.lng,
    }))
    .sort((x, y) => x.start - y.start);
  return {
    imei,
    name: o?.name || imei,
    area: o?.area || null,
    points: points.length,
    firstSeen: points.length ? points[0].gpsSec : null,
    lastSeen: points.length ? points[points.length - 1].gpsSec : null,
    distanceKm: trackKm(points),
    officeMinutes: a.officeMinutes,
    customersMet: a.visits.length,
    withCustomersMin: a.visits.reduce((s, v) => s + v.minutes, 0),
    visits: a.visits,
    unexplained: a.unexplained,
    timeline,
  };
}

// Build the full report object for a date. Caller should refresh the customer
// geofence first so customer matching is populated.
export async function buildReport(gps, date = eatToday()) {
  const { start, end } = dayBounds(date);
  const roster = [...officerImeis()];
  const officers = [];
  const CONC = 4;
  for (let i = 0; i < roster.length; i += CONC) {
    const batch = roster.slice(i, i + CONC);
    const done = await Promise.all(batch.map((imei) => officerDay(gps, imei, start, end).catch(() => null)));
    done.forEach((o) => { if (o) officers.push(o); });
  }
  officers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { date, start, end, count: officers.length, officers };
}

// ---- self-contained HTML rendering (no server needed to view the file) ----
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function hm(sec) {
  if (!sec) return '—';
  const d = new Date((sec + 3 * 3600) * 1000);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function dur(min) {
  if (!min) return '0m';
  const h = Math.floor(min / 60), m = min % 60;
  return (h ? h + 'h ' : '') + m + 'm';
}

function officerBlock(o) {
  let h = `<div class="officer"><h2>${esc(o.name)}</h2>
    <div class="sub">${o.area ? esc(o.area) + ' · ' : ''}on the road ${hm(o.firstSeen)}–${hm(o.lastSeen)}</div>
    <div class="stats">
      <div class="stat"><div class="n">${o.customersMet}</div><div class="l">customers met</div></div>
      <div class="stat"><div class="n">${dur(o.withCustomersMin)}</div><div class="l">time with customers</div></div>
      <div class="stat"><div class="n">${dur(o.officeMinutes)}</div><div class="l">at office</div></div>
      <div class="stat"><div class="n">${o.distanceKm} km</div><div class="l">distance</div></div>
      <div class="stat"><div class="n">${o.unexplained.length}</div><div class="l">unexplained stops</div></div>
    </div>`;
  if (o.visits.length) {
    h += `<h3>Customers interacted with</h3><table><tr><th>Customer</th><th>Total time</th><th>Visits</th><th>Times</th></tr>`;
    for (const v of o.visits) {
      h += `<tr><td>${esc(v.name)}${v.phone ? ' <span class="muted">' + esc(v.phone) + '</span>' : ''}</td>
        <td><b>${dur(v.minutes)}</b></td><td>${v.stops.length}</td>
        <td class="muted">${v.stops.map((s) => hm(s.start) + '–' + hm(s.end)).join(', ')}</td></tr>`;
    }
    h += `</table>`;
  } else {
    h += `<div class="muted" style="padding:6px 0">No customer interactions detected.</div>`;
  }
  h += `<h3>Whereabouts timeline</h3><table><tr><th>From</th><th>To</th><th>Duration</th><th>Place</th></tr>`;
  if (o.timeline.length) {
    for (const t of o.timeline) {
      const tag = t.type === 'customer' ? 't-customer' : t.type === 'office' ? 't-office' : 't-unknown';
      const label = t.type === 'customer' ? 'Customer: ' + esc(t.name)
        : t.type === 'office' ? esc(t.name || 'Office')
        : `<a href="https://www.google.com/maps?q=${t.lat},${t.lng}" target="_blank">Unexplained stop</a>`;
      h += `<tr><td>${hm(t.start)}</td><td>${hm(t.end)}</td><td>${dur(t.minutes)}</td><td><span class="tag ${tag}">${label}</span></td></tr>`;
    }
  } else {
    h += `<tr><td colspan="4" class="muted">No stops ≥ threshold — officer was moving or had no fixes.</td></tr>`;
  }
  return h + `</table></div>`;
}

export function renderReportHtml(report) {
  const totalVisits = report.officers.reduce((s, o) => s + o.customersMet, 0);
  const body = report.officers.length
    ? report.officers.map(officerBlock).join('')
    : `<div class="empty">No field officers configured for ${report.date}.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Officer Day Report ${report.date}</title>
<style>
  body{margin:0;background:#fff;color:#111;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #wrap{max-width:1000px;margin:0 auto;padding:24px}
  h1{font-size:19px;margin:0 0 2px} .day-sum{color:#555;font-size:13px;margin-bottom:16px}
  .officer{border:1px solid #ddd;border-radius:12px;padding:16px 18px;margin-bottom:16px;break-inside:avoid}
  .officer h2{font-size:16px;margin:0 0 2px} .officer .sub{color:#555;font-size:12px;margin-bottom:10px}
  .stats{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0 14px}
  .stat{border:1px solid #ddd;border-radius:8px;padding:8px 12px;min-width:96px}
  .stat .n{font-size:18px;font-weight:700} .stat .l{font-size:11px;color:#555}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}
  th{color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px}
  .t-office{background:#dbeafe;color:#1e3a8a}.t-customer{background:#dcfce7;color:#14532d}.t-unknown{background:#ffedd5;color:#7c2d12}
  .muted{color:#777} h3{font-size:13px;margin:14px 0 4px} a{color:#2563eb}
  .empty{color:#777;padding:40px;text-align:center}
</style></head><body><div id="wrap">
  <h1>Field Officer — Day Report</h1>
  <div class="day-sum"><b>${report.date}</b> · ${report.officers.length} officer(s) · ${totalVisits} customer interaction(s)</div>
  ${body}
</div></body></html>`;
}

// Write both the HTML and JSON for a report into the reports directory; returns
// the file paths.
export function writeReportFiles(report, dir = config.reportsDir) {
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, `report-${report.date}.html`);
  const jsonPath = path.join(dir, `report-${report.date}.json`);
  fs.writeFileSync(htmlPath, renderReportHtml(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { htmlPath, jsonPath };
}

export function listReports(dir = config.reportsDir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^report-\d{4}-\d{2}-\d{2}\.html$/.test(f))
      .map((f) => f.slice('report-'.length, -'.html'.length))
      .sort((a, b) => b.localeCompare(a));
  } catch { return []; }
}
