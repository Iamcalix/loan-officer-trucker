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

// Canonical plate key — also strips a trailing tracker-index digit ("MC693FML1" →
// "MC693FML") so a bike's two trackers map to one plate.
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
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

// Sentinel plates (no schema change): off-plan stop, and time-at-office (so we can
// report when the officer left the head office). start_ts keeps each row unique.
const UNKNOWN_PLATE = 'UNK';
const OFFICE_PLATE = 'OFFICE';

// Record one officer's current state at sample time. `place` is the assigned-place
// result ({type:'customer'|'office', name, plate} or null). Only a STATIONARY
// officer is logged, either as WITH one of their assigned customers, or — if
// stopped somewhere that is neither an assigned customer nor the office — as an
// OFF-PLAN ("unknown") stop.
export async function record(officerImei, place, nowSec, speedKmh, lat, lng, fixAgeSec) {
  // GATE: only log a visit from a FRESH officer fix. A parked/stale tracker keeps
  // echoing its last position on every refresh; without this, an officer whose bike
  // sits all day near a customer's parked bike accrues a phantom all-day "visit" he
  // never made (he never travelled there). If the officer's fix isn't recent we
  // cannot assert where he is now — freeze and close any open session instead.
  const officerFresh = fixAgeSec != null && fixAgeSec <= config.offlineAfterMin * 60;
  if (!officerFresh) {
    const c = open.get(officerImei);
    if (c) { await persist(officerImei, c); open.delete(officerImei); }
    return;
  }
  const stationary = speedKmh == null ? true : speedKmh <= config.proximity.stopSpeedKmh;
  // "Stopped to talk": the officer's bike is essentially STOPPED (≈0). The customer
  // side is lenient — we only rule out a customer who is clearly RIDING BY (moving
  // fast), so GPS jitter on a parked bike never drops a real meeting.
  const meet = config.proximity.meetSpeedKmh;
  const officerStopped = speedKmh == null ? true : speedKmh <= meet;
  const custStopped = place?.custSpeed == null ? true : place.custSpeed <= config.proximity.movingSpeedKmh;
  const hasPos = Number.isFinite(lat) && Number.isFinite(lng);

  let target = null; // { plate, name }
  if (place && place.type === 'customer' && officerStopped && custStopped) {
    const pl = normPlate(place.plate || place.name);
    target = { plate: pl, name: customerByPlate(pl)?.name || place.name };
  } else if (place && place.type === 'office') {
    target = { plate: OFFICE_PLATE, name: '' }; // at the head office — track presence to know when they leave
  } else if (stationary && hasPos && !place) {
    target = { plate: UNKNOWN_PLATE, name: '' }; // stopped off-plan
  }

  const cur = open.get(officerImei);
  if (target && cur && cur.plate === target.plate) {
    // same session continues — extend it, keep the latest location
    cur.lastTs = nowSec;
    if (hasPos) { cur.lat = lat; cur.lng = lng; }
    if (nowSec - (cur.lastPersist || 0) >= 60) await persist(officerImei, cur);
    return;
  }
  // state changed (moved on / different customer / went to office) — close previous
  if (cur) { await persist(officerImei, cur); open.delete(officerImei); }
  if (target) {
    const s = {
      day: eatDay(nowSec), plate: target.plate, name: target.name,
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
    // gates out drive-bys; r.fixAgeSec gates out a stale/parked officer fix.
    await record(r.imei, r.place, nowSec, r.speedKmh, r.lat, r.lng, r.fixAgeSec).catch(() => {});
  }
}

// ---- read side (report + live "met today" badge) ----
export async function getVisits(day) {
  if (!supabaseEnabled()) return new Map();
  // Real customer visits only (exclude off-plan stops and office presence).
  const rows = await sbSelect(`visits?day=eq.${day}&customer_plate=not.in.(${UNKNOWN_PLATE},${OFFICE_PLATE})&select=officer_imei,customer_plate,customer_name,start_ts,end_ts,seconds,lat,lng&order=start_ts`);
  const byOfficer = new Map();
  for (const r of rows) {
    const imei = String(r.officer_imei);
    if (!byOfficer.has(imei)) byOfficer.set(imei, new Map());
    const perCust = byOfficer.get(imei);
    const key = normPlate(r.customer_plate); // canonical → merges MC693FML1/MC693FML2
    const v = perCust.get(key) || { plate: key, name: customerByPlate(key)?.name || r.customer_name || key, phone: '', minutes: 0, stops: [], lat: null, lng: null };
    v.minutes += Math.round((r.seconds || 0) / 60);
    v.stops.push({ start: r.start_ts, end: r.end_ts, minutes: Math.round((r.seconds || 0) / 60) });
    // Keep a meeting location for the map (prefer the longest/most recent session).
    if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) { v.lat = r.lat; v.lng = r.lng; }
    perCust.set(key, v);
  }
  // → Map(officerImei -> [visit,...]). Keep any real STATIONARY presence (≥1min);
  // sessions already require the officer to be stopped, so this isn't a drive-by.
  // The report applies the stricter 5-min bar only to UNASSIGNED meetings; an
  // assigned customer counts as visited on any real stop (they were sent there).
  const minMin = 1;
  const out = new Map();
  for (const [imei, perCust] of byOfficer) {
    const kept = [...perCust.values()].filter((v) => v.minutes >= minMin).sort((a, b) => b.minutes - a.minutes);
    if (kept.length) out.set(imei, kept);
  }
  return out;
}

// Per-officer extras for the report: work start/end times and off-plan (unknown)
// stops. Derived from ALL logged sessions (customer + off-plan) for the day.
export async function getExtras(day) {
  if (!supabaseEnabled()) return new Map();
  const rows = await sbSelect(`visits?day=eq.${day}&select=officer_imei,customer_plate,start_ts,end_ts,seconds,lat,lng&order=start_ts`);
  const minSec = MIN_VISIT_SEC();
  const out = new Map();
  const get = (imei) => {
    if (!out.has(imei)) out.set(imei, { workStart: null, workEnd: null, firstCustomerTs: null, leftOfficeTs: null, unknownStops: [] });
    return out.get(imei);
  };
  for (const r of rows) {
    if ((r.seconds || 0) < minSec) continue; // ignore momentary stops
    const e = get(String(r.officer_imei));
    if (r.customer_plate === OFFICE_PLATE) {
      // "Left office" = when the EARLIEST office presence ended (departed for the field).
      e.leftOfficeTs = e.leftOfficeTs == null ? r.end_ts : Math.min(e.leftOfficeTs, r.end_ts);
      continue; // office is not field activity — don't count toward work start/end
    }
    e.workStart = e.workStart == null ? r.start_ts : Math.min(e.workStart, r.start_ts);
    e.workEnd = e.workEnd == null ? r.end_ts : Math.max(e.workEnd, r.end_ts);
    if (r.customer_plate === UNKNOWN_PLATE) {
      e.unknownStops.push({ lat: r.lat, lng: r.lng, start: r.start_ts, end: r.end_ts, minutes: Math.round((r.seconds || 0) / 60) });
    } else {
      e.firstCustomerTs = e.firstCustomerTs == null ? r.start_ts : Math.min(e.firstCustomerTs, r.start_ts);
    }
  }
  for (const e of out.values()) e.unknownStops.sort((a, b) => a.start - b.start);
  return out;
}
