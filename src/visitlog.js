// Live visit logging — the platform-independent way to know "did the officer meet
// a customer, and for how long".
//
// WHY: the day report's "customers met" originally came from replaying the
// officer's GPS *history*. 18gps (where most trackers live) exposes no usable
// history endpoint, so 18gps-tracked officers always showed 0. This module instead
// SAMPLES live proximity as it happens (we already fetch live positions for both
// platforms every dashboard refresh) and records continuous "with customer"
// sessions to Supabase. Works identically for Wanway and 18gps.
//
// Table: visits(id, day, officer_imei, customer_plate, customer_name,
//               start_ts, end_ts, seconds, updated_at)
// unique(day, officer_imei, customer_plate, start_ts)

import { config } from './config.js';
import { supabaseEnabled, sb, sbSelect } from './supa.js';
import { customerByPlate } from './register.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const eatDay = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10);
// A real "visit" = officer parked NEAR a customer for at least this long. Anything
// shorter is a drive-by (a rider passes dozens of parked customer bikes a day) and
// must NOT count — this is what made the live badge read 49 vs the report's 1.
const MIN_VISIT_SEC = () => config.proximity.stopMinMinutes * 60;

// officerImei -> { day, plate, name, startTs, lastTs, lastPersist }
const open = new Map();

async function persist(officerImei, s) {
  if (!supabaseEnabled()) return;
  const row = {
    day: s.day, officer_imei: String(officerImei), customer_plate: s.plate,
    customer_name: s.name || '', start_ts: s.startTs, end_ts: s.lastTs,
    seconds: Math.max(0, s.lastTs - s.startTs),
    lat: s.lat ?? null, lng: s.lng ?? null,
  };
  try {
    await sb('visits?on_conflict=day,officer_imei,customer_plate,start_ts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([row]),
    });
    s.lastPersist = s.lastTs;
  } catch { /* transient — will retry on the next sample */ }
}

// Record one officer's current classification. `place` is the classify() result
// (a {type:'customer', id, name} or office/null). nowSec = sample time. speedKmh
// is the officer's live speed — only a STATIONARY officer counts as "with" the
// customer, so riding past a parked customer bike is ignored.
export async function record(officerImei, place, nowSec, speedKmh, lat, lng) {
  const stationary = speedKmh == null ? true : speedKmh <= config.proximity.stopSpeedKmh;
  const isCust = Boolean(place && place.type === 'customer' && stationary);
  const plate = isCust ? normPlate(place.name) : null;
  const cur = open.get(officerImei);
  const hasPos = Number.isFinite(lat) && Number.isFinite(lng);

  if (isCust && cur && cur.plate === plate) {
    // still with the same customer — extend the session (keep the meeting location)
    cur.lastTs = nowSec;
    if (hasPos) { cur.lat = lat; cur.lng = lng; }
    if (nowSec - (cur.lastPersist || 0) >= 60) await persist(officerImei, cur);
    return;
  }
  // customer changed or officer left — close the previous session for good
  if (cur) { await persist(officerImei, cur); open.delete(officerImei); }
  if (isCust) {
    const c = customerByPlate(plate);
    const s = {
      day: eatDay(nowSec), plate, name: c?.name || place.name,
      startTs: nowSec, lastTs: nowSec, lastPersist: 0,
      lat: hasPos ? lat : null, lng: hasPos ? lng : null,
    };
    open.set(officerImei, s);
    await persist(officerImei, s);
  }
}

// Sample every officer in the current snapshot rows (each has imei + classified
// place). Called from buildSnapshot so it runs on every dashboard refresh.
export async function sampleFromRows(rows, nowSec) {
  for (const r of rows) {
    // r.place is the map snapshot's place ({type,name,distM}) or null; r.speedKmh
    // gates out drive-bys.
    await record(r.imei, r.place, nowSec, r.speedKmh, r.lat, r.lng).catch(() => {});
  }
}

// ---- read side (report + live "met today" badge) ----
export async function getVisits(day) {
  if (!supabaseEnabled()) return new Map();
  const rows = await sbSelect(`visits?day=eq.${day}&select=officer_imei,customer_plate,customer_name,start_ts,end_ts,seconds,lat,lng&order=start_ts`);
  const byOfficer = new Map();
  for (const r of rows) {
    const imei = String(r.officer_imei);
    if (!byOfficer.has(imei)) byOfficer.set(imei, new Map());
    const perCust = byOfficer.get(imei);
    const key = r.customer_plate;
    const v = perCust.get(key) || { plate: r.customer_plate, name: r.customer_name || r.customer_plate, phone: '', minutes: 0, stops: [], lat: null, lng: null };
    v.minutes += Math.round((r.seconds || 0) / 60);
    v.stops.push({ start: r.start_ts, end: r.end_ts, minutes: Math.round((r.seconds || 0) / 60) });
    // Keep a meeting location for the map (prefer the longest/most recent session).
    if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) { v.lat = r.lat; v.lng = r.lng; }
    perCust.set(key, v);
  }
  // → Map(officerImei -> [visit,...]), keeping only customers the officer actually
  // spent real time with (filters drive-by proximity that would inflate the count).
  const minMin = Math.max(1, Math.round(MIN_VISIT_SEC() / 60));
  const out = new Map();
  for (const [imei, perCust] of byOfficer) {
    const kept = [...perCust.values()].filter((v) => v.minutes >= minMin).sort((a, b) => b.minutes - a.minutes);
    if (kept.length) out.set(imei, kept);
  }
  return out;
}
