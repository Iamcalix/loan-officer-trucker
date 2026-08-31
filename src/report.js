// End-of-day report — now focused entirely on the daily FOLLOW-LIST: for each
// agent, the customers they were assigned to visit, whether they visited them,
// and for how long. Built from the live visit log (works for both GPS platforms)
// cross-referenced against the day's assignments. No general customer/route data.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { officerFor, officerImeis } from './officers.js';
import { haversineM } from './places.js';

// Today's date (YYYY-MM-DD) in East Africa Time (UTC+3), independent of server TZ.
export function eatToday() {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}
export function eatYesterday() {
  return new Date(Date.now() + 3 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}

// Canonical plate key — also strips a trailing tracker-index digit ("MC693FML1" →
// "MC693FML") so a bike's two trackers map to one plate.
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');

// Cross-reference an agent's assigned follow-list against the customers they were
// actually logged with → visited (with duration) vs. not visited.
function assignedSummary(items, visits) {
  const byPlate = new Map();
  for (const v of visits) {
    const p = normPlate(v.plate || v.name);
    if (!p) continue;
    const cur = byPlate.get(p) || { minutes: 0, stops: [], lat: null, lng: null };
    cur.minutes += v.minutes; cur.stops.push(...v.stops);
    if (Number.isFinite(v.lat) && Number.isFinite(v.lng)) { cur.lat = v.lat; cur.lng = v.lng; }
    byPlate.set(p, cur);
  }
  const list = items.map((it) => {
    const hit = it.matched && it.plate ? byPlate.get(normPlate(it.plate)) : null;
    return {
      name: it.name, plate: it.plate || null, matched: Boolean(it.matched),
      visited: Boolean(hit), minutes: hit ? hit.minutes : 0, stops: hit ? hit.stops : [],
      lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
      enteredName: it.enteredName, comment: it.comment || '',
    };
  });
  return {
    total: items.length,
    matched: items.filter((i) => i.matched).length,
    visited: list.filter((l) => l.visited).length,
    minutes: list.reduce((s, l) => s + l.minutes, 0),
    items: list,
  };
}

// Build the per-agent follow-list report for a date. `assignmentsByOfficer` maps
// officerImei -> assignment items; `visitsByOfficer` maps officerImei -> logged
// visits. (gps is unused now — kept for a stable call signature.)
export async function buildReport(gps, date = eatToday(), assignmentsByOfficer = new Map(), visitsByOfficer = new Map(), extrasByOfficer = new Map()) {
  const officers = [...officerImeis()].map((imei) => {
    const o = officerFor(imei);
    const items = assignmentsByOfficer.get(imei) || [];
    const visits = visitsByOfficer.get(imei) || [];
    const ex = extrasByOfficer.get(imei) || {};
    const assigned = items.length ? assignedSummary(items, visits) : null;
    // First ASSIGNED customer reached today (consistent with the visited count).
    let firstCustomerTs = null;
    if (assigned) {
      for (const it of assigned.items) {
        if (!it.visited) continue;
        for (const s of it.stops) firstCustomerTs = firstCustomerTs == null ? s.start : Math.min(firstCustomerTs, s.start);
      }
    }
    // Customers the officer spent ≥5min with that were NOT on their follow-list.
    const assignedPlates = new Set(items.filter((i) => i.plate).map((i) => normPlate(i.plate)));
    // Unassigned meetings are sensitive → only report high-confidence ones: a long,
    // genuine stay (the tight proximity is already enforced at detection time).
    // SAFETY NET: if the officer was visiting an ASSIGNED customer at that same spot,
    // a bystander bike nearby is NOT an off-list meeting — drop it.
    const assignedLocs = assigned
      ? assigned.items.filter((i) => i.visited && Number.isFinite(i.lat)).map((i) => ({ lat: i.lat, lng: i.lng }))
      : [];
    const unassigned = visits
      .filter((v) => !assignedPlates.has(normPlate(v.plate || v.name)) && v.minutes >= config.proximity.unassignedMinMinutes)
      .filter((v) => !(Number.isFinite(v.lat) && assignedLocs.some((a) => haversineM(a, v) <= config.proximity.customerRadiusM)))
      .map((v) => ({ name: v.name, plate: v.plate || null, minutes: v.minutes, stops: v.stops, lat: v.lat, lng: v.lng }))
      .sort((x, y) => y.minutes - x.minutes);

    // Travel time BETWEEN customers: order every customer stop chronologically and
    // measure the gap from leaving one to reaching the next.
    const events = [];
    if (assigned) for (const it of assigned.items) if (it.visited) for (const s of it.stops) events.push({ name: it.name, start: s.start, end: s.end });
    for (const u of unassigned) for (const s of u.stops) events.push({ name: u.name, start: s.start, end: s.end });
    events.sort((x, y) => x.start - y.start);
    const between = [];
    for (let i = 1; i < events.length; i++) {
      const gap = events[i].start - events[i - 1].end;
      if (gap >= 60 && events[i - 1].name !== events[i].name) {
        between.push({ from: events[i - 1].name, to: events[i].name, leftAt: events[i - 1].end, reachedAt: events[i].start, minutes: Math.round(gap / 60) });
      }
    }
    return {
      imei,
      name: o?.name || imei,
      area: o?.area || null,
      assigned,
      unassigned,
      between,
      // "Started" = reached the first assigned customer, else first activity of the day.
      startedTs: firstCustomerTs ?? ex.workStart ?? null,
      firstCustomerTs,
      leftOfficeTs: ex.leftOfficeTs ?? null,
      endedTs: ex.workEnd ?? null,
      unknownStops: ex.unknownStops || [],
    };
  });
  officers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { date, count: officers.length, officers };
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
  const a = o.assigned;
  const shift = (o.startedTs || o.endedTs || o.leftOfficeTs)
    ? `🕒 Started ${hm(o.startedTs)}${o.firstCustomerTs ? ' (1st customer)' : ''}${o.leftOfficeTs ? ` · left head office ${hm(o.leftOfficeTs)}` : ''} · finished ${hm(o.endedTs)}`
    : 'no activity logged today';
  let h = `<div class="officer"><h2>${esc(o.name)}</h2>
    <div class="sub">${o.area ? esc(o.area) + ' · ' : ''}${a ? `${a.visited}/${a.total} assigned customers visited` : 'no follow-list assigned today'}</div>
    <div class="sub">${shift}</div>`;

  if (a) {
    const visited = a.items.filter((i) => i.visited).sort((x, y) => y.minutes - x.minutes);
    const notVisited = a.items.filter((i) => !i.visited);
    h += `<div class="stats">
      <div class="stat"><div class="n">${a.visited}/${a.total}</div><div class="l">visited</div></div>
      <div class="stat"><div class="n">${dur(a.minutes)}</div><div class="l">total time with them</div></div>
      <div class="stat"><div class="n">${notVisited.length}</div><div class="l">not visited</div></div>
      <div class="stat"><div class="n">${o.unknownStops.length}</div><div class="l">off-plan stops</div></div>
    </div>`;
    h += `<table><tr><th>Customer</th><th>Status</th><th>Time with them</th><th>When</th><th>Where</th><th>Note</th></tr>`;
    for (const i of visited) {
      const where = Number.isFinite(i.lat) ? `<a href="https://www.google.com/maps?q=${i.lat},${i.lng}" target="_blank">map</a>` : '—';
      h += `<tr><td>${esc(i.name)}</td><td><span class="tag t-customer">Visited</span></td>
        <td><b>${dur(i.minutes)}</b></td><td class="muted">${i.stops.map((s) => hm(s.start) + '–' + hm(s.end)).join(', ')}</td><td>${where}</td><td>${esc(i.comment)}</td></tr>`;
    }
    for (const i of notVisited) {
      h += `<tr><td>${esc(i.name)}${i.matched ? '' : ' <span class="muted">(unmatched)</span>'}</td>
        <td><span class="tag t-unknown">Not visited</span></td><td class="muted">—</td><td></td><td class="muted">—</td><td>${esc(i.comment)}</td></tr>`;
    }
    h += `</table>`;
  } else {
    h += `<div class="muted" style="padding:6px 0">No follow-list assigned for this agent today.</div>`;
  }

  if (o.unassigned && o.unassigned.length) {
    h += `<h3>Met unassigned customers (not on their follow-list) — ${o.unassigned.length}</h3>
      <table><tr><th>Customer</th><th>Time with them</th><th>When</th><th>Where</th></tr>`;
    for (const u of o.unassigned) {
      const where = Number.isFinite(u.lat) ? `<a href="https://www.google.com/maps?q=${u.lat},${u.lng}" target="_blank">map</a>` : '—';
      h += `<tr><td>${esc(u.name)}</td><td><b>${dur(u.minutes)}</b></td>
        <td class="muted">${u.stops.map((s) => hm(s.start) + '–' + hm(s.end)).join(', ')}</td><td>${where}</td></tr>`;
    }
    h += `</table>`;
  }

  if (o.between && o.between.length) {
    const total = o.between.reduce((s, b) => s + b.minutes, 0);
    h += `<h3>Time between customers — ${dur(total)} travelling</h3>
      <table><tr><th>From</th><th>To</th><th>Left</th><th>Arrived</th><th>Travel</th></tr>`;
    for (const b of o.between) {
      h += `<tr><td>${esc(b.from)}</td><td>${esc(b.to)}</td><td class="muted">${hm(b.leftAt)}</td><td class="muted">${hm(b.reachedAt)}</td><td><b>${dur(b.minutes)}</b></td></tr>`;
    }
    h += `</table>`;
  }

  if (o.unknownStops.length) {
    h += `<h3>Off-plan stops (not the office or an assigned customer) — ${o.unknownStops.length}</h3>
      <table><tr><th>From</th><th>To</th><th>Duration</th><th>Where</th></tr>`;
    for (const s of o.unknownStops) {
      const loc = Number.isFinite(s.lat) ? `<a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank">map</a>` : '—';
      h += `<tr><td>${hm(s.start)}</td><td>${hm(s.end)}</td><td>${dur(s.minutes)}</td><td>${loc}</td></tr>`;
    }
    h += `</table>`;
  }
  return h + `</div>`;
}

export function renderReportHtml(report) {
  const withList = report.officers.filter((o) => o.assigned);
  const totVisited = withList.reduce((s, o) => s + o.assigned.visited, 0);
  const totAssigned = withList.reduce((s, o) => s + o.assigned.total, 0);
  const body = report.officers.length
    ? report.officers.map(officerBlock).join('')
    : `<div class="empty">No field officers configured for ${report.date}.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Follow-list Report ${report.date}</title>
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
  .t-customer{background:#dcfce7;color:#14532d}.t-unknown{background:#ffedd5;color:#7c2d12}
  .muted{color:#777} a{color:#2563eb}
  .empty{color:#777;padding:40px;text-align:center}
</style></head><body><div id="wrap">
  <h1>Field Officer — Follow-list Report</h1>
  <div class="day-sum"><b>${report.date}</b> · ${withList.length} agent(s) with a follow-list · ${totVisited}/${totAssigned} assigned customers visited</div>
  ${body}
</div></body></html>`;
}

// Write both the HTML and JSON for a report into the reports directory.
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
