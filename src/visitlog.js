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

// officerImei -> { day, plate, name, startTs, lastTs, lastPersist, lastFreshTs }
// The single "fallback" session per officer: office presence / off-plan stop /
// unassigned meeting (only while NOT with an assigned customer).
const open = new Map();

// officerImei -> Map(normPlate -> session): CONCURRENT assigned-customer visits.
// An officer parked among several assigned customers' bikes is "with" all of them,
// so each gets its own live session — a clustered stop no longer credits only the
// nearest one.
const openA = new Map();

// A parked officer's bike stops fixing GPS (engine off while he sits with the
// customer), so its fix goes "stale" mid-visit. We keep the visit alive across that
// gap — but only up to this long — so a genuine sit-down still counts while a bike
// that simply dies can't inflate a visit forever.
const MAX_STALE_COAST_SEC = 30 * 60;

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

// Record one officer's current state at sample time.
//   assignedInRange: [{plate, name, custSpeed}] — EVERY assigned customer within
//     range with a trustworthy position (already gated server-side). All are credited.
//   fallbackPlace: {type:'office'|'customer'(unassigned)} or null — used ONLY when the
//     officer is with no assigned customer (office presence / off-plan / unassigned).
// Freshness rule (both paths): a FRESH officer fix is needed to OPEN a session (proves
// he arrived), but an open session COASTS through a stale gap (engine off while he sits)
// up to MAX_STALE_COAST_SEC — so parked visits aren't truncated and stale-at-base bikes
// can't fabricate a visit.
export async function record(officerImei, assignedInRange, fallbackPlace, nowSec, speedKmh, lat, lng, fixAgeSec) {
  const officerFresh = fixAgeSec != null && fixAgeSec <= config.offlineAfterMin * 60;
  const officerStopped = speedKmh == null ? true : speedKmh <= config.proximity.meetSpeedKmh;
  const stationary = speedKmh == null ? true : speedKmh <= config.proximity.stopSpeedKmh;
  const hasPos = Number.isFinite(lat) && Number.isFinite(lng);
  const coasting = (s) => nowSec - (s.lastFreshTs || s.startTs) <= MAX_STALE_COAST_SEC;
  const bump = async (s) => { s.lastTs = nowSec; if (hasPos) { s.lat = lat; s.lng = lng; } if (nowSec - (s.lastPersist || 0) >= 60) await persist(officerImei, s); };

  // ---------- ASSIGNED customers in range (concurrent sessions) ----------
  // The officer is "with" a customer when HE is stopped and the customer's bike isn't
  // riding by. Every qualifying assigned customer is a live target this sample.
  const current = new Map(); // normPlate -> display name
  if (officerStopped) {
    for (const c of (assignedInRange || [])) {
      const custStopped = c.custSpeed == null ? true : c.custSpeed <= config.proximity.movingSpeedKmh;
      if (custStopped) current.set(normPlate(c.plate), c.name);
    }
  }
  const aMap = openA.get(officerImei) || new Map();
  // open / extend each current target
  for (const [plate, name] of current) {
    const s = aMap.get(plate);
    if (s) {
      if (officerFresh) { s.lastFreshTs = nowSec; await bump(s); }
      else if (coasting(s)) { await bump(s); }         // parked, engine off — keep alive
      // else: stale too long → closed by the sweep below
    } else if (officerFresh) {                          // fresh fix here = genuine arrival
      const ns = { day: eatDay(nowSec), plate, name: customerByPlate(plate)?.name || name,
        startTs: nowSec, lastTs: nowSec, lastPersist: 0, lastFreshTs: nowSec,
        lat: hasPos ? lat : null, lng: hasPos ? lng : null };
      aMap.set(plate, ns);
      await persist(officerImei, ns);
    }
  }
  // close assigned sessions no longer current (moved on) or stale beyond the coast
  for (const [plate, s] of [...aMap]) {
    if (current.has(plate) && coasting(s)) continue;
    await persist(officerImei, s); aMap.delete(plate);
  }
  if (aMap.size) openA.set(officerImei, aMap); else openA.delete(officerImei);

  // ---------- Fallback (office / off-plan / unassigned) — only when with NO assigned ----------
  if (current.size > 0) {
    const c = open.get(officerImei);
    if (c) { await persist(officerImei, c); open.delete(officerImei); }
    return;
  }
  if (!officerFresh) {
    const c = open.get(officerImei);
    if (c && coasting(c)) { await bump(c); }
    else if (c) { await persist(officerImei, c); open.delete(officerImei); }
    return;
  }
  let target = null; // { plate, name }
  if (fallbackPlace && fallbackPlace.type === 'office') {
    target = { plate: OFFICE_PLATE, name: '' };
  } else if (fallbackPlace && fallbackPlace.type === 'customer') { // an unassigned bike
    const custStopped = fallbackPlace.custSpeed == null ? true : fallbackPlace.custSpeed <= config.proximity.movingSpeedKmh;
    if (officerStopped && custStopped) {
      const pl = normPlate(fallbackPlace.plate || fallbackPlace.name);
      target = { plate: pl, name: customerByPlate(pl)?.name || fallbackPlace.name };
    } else if (stationary && hasPos) target = { plate: UNKNOWN_PLATE, name: '' };
  } else if (stationary && hasPos) {
    target = { plate: UNKNOWN_PLATE, name: '' }; // stopped off-plan
  }

  const cur = open.get(officerImei);
  if (target && cur && cur.plate === target.plate) {
    cur.lastFreshTs = nowSec;
    await bump(cur);
    return;
  }
  if (cur) { await persist(officerImei, cur); open.delete(officerImei); }
  if (target) {
    const s = {
      day: eatDay(nowSec), plate: target.plate, name: target.name,
      startTs: nowSec, lastTs: nowSec, lastPersist: 0, lastFreshTs: nowSec,
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
    // r.assignedInRange = every assigned customer in range (fresh position); r.fallbackPlace
    // = office/unassigned/off-plan; r.speedKmh gates drive-bys; r.fixAgeSec gates a stale fix.
    await record(r.imei, r.assignedInRange, r.fallbackPlace, nowSec, r.speedKmh, r.lat, r.lng, r.fixAgeSec).catch(() => {});
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
