// Bike transfers — the two-stage "repossession / move to storage" workflow, with a
// mandatory 4-sides photo record at each stage so the bike's condition is documented
// by whoever had it at that moment.
//
// STAGE 1 'field'   — the FIELD OFFICER, at the customer's bike, decides to take it to
//                     head office. He photographs all 4 sides (front/back/left/right).
// STAGE 2 'receiver'— a DIFFERENT person (the receiver) takes the bike from head office
//                     to the storage area. He re-photographs all 4 sides on receipt.
//
// The two stages are stored SEPARATELY (own rows + own Storage sub-folders) because they
// are different people documenting the bike at different points — so a later dispute can
// tell exactly how the bike looked when the officer handed it in vs. when the receiver
// took it on. Photos live in the same private `checkins` bucket under a `transfers/`
// prefix so the existing signed-URL viewer serves them unchanged.
//
// Table (run once in the Supabase SQL editor):
//   create table if not exists bike_transfers (
//     id bigint generated always as identity primary key,
//     day date not null,
//     stage text not null,                 -- 'field' | 'receiver'
//     actor_imei text,                     -- field officer imei (null for receiver)
//     actor_name text not null,            -- who performed this stage
//     customer_plate text, customer_name text,
//     lat double precision, lng double precision, ts bigint not null,
//     photo_front text, photo_back text, photo_left text, photo_right text,
//     note text,
//     created_at timestamptz default now());
//   create index if not exists bike_transfers_day on bike_transfers(day, stage);

import { config } from './config.js';
import { supabaseEnabled, sb, sbSelect } from './supa.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
const eatDay = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10);
const BUCKET = 'checkins';
export const SIDES = ['front', 'back', 'left', 'right'];
export const STAGES = ['field', 'receiver'];

async function uploadPhoto(path, buf, mime) {
  const { url, key } = config.supabase;
  const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': mime || 'image/jpeg', 'x-upsert': 'true' },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`storage upload ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return path;
}

// Record one transfer stage: upload all 4 side photos, insert the row. `photos` is
// { front, back, left, right } of raw image Buffers — ALL FOUR are required.
export async function recordTransfer({ stage, actorImei, actorName, plate, name, lat, lng, ts, photos, note, mime }) {
  if (!supabaseEnabled()) throw new Error('storage not configured');
  if (!STAGES.includes(stage)) throw new Error('bad stage');
  photos = photos || {};
  const missing = SIDES.filter((s) => !(photos[s] && photos[s].length));
  if (missing.length) throw new Error('all 4 photos required — missing: ' + missing.join(', '));

  const sec = Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Math.floor(Date.now() / 1000);
  const day = eatDay(sec);
  const p = normPlate(plate);
  const hasPos = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  const paths = {};
  for (const s of SIDES) {
    const path = `transfers/${day}/${stage}/${p || 'UNK'}-${sec}-${s}.jpg`;
    await uploadPhoto(path, photos[s], mime || 'image/jpeg');
    paths[s] = path;
  }

  const row = {
    day, stage, actor_imei: actorImei ? String(actorImei) : null, actor_name: String(actorName || '').slice(0, 120),
    customer_plate: p || null, customer_name: name || '',
    lat: hasPos ? Number(lat) : null, lng: hasPos ? Number(lng) : null, ts: sec,
    photo_front: paths.front, photo_back: paths.back, photo_left: paths.left, photo_right: paths.right,
    note: note ? String(note).slice(0, 500) : null,
  };
  await sb('bike_transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify([row]),
  });

  return { ok: true, day, stage, plate: p, photos: paths };
}

// Transfers for a day (optionally one stage) → rows with normalized plate + photo paths.
export async function getTransfers(day, stage) {
  if (!supabaseEnabled()) return [];
  let q = `bike_transfers?day=eq.${day}&select=*&order=ts.desc`;
  if (stage) q += `&stage=eq.${encodeURIComponent(stage)}`;
  let rows;
  try { rows = await sbSelect(q); } catch { return []; }
  return rows.map((r) => ({
    id: r.id, day: r.day, stage: r.stage,
    actorImei: r.actor_imei ? String(r.actor_imei) : null, actorName: r.actor_name || '',
    plate: normPlate(r.customer_plate), name: r.customer_name || '',
    lat: r.lat, lng: r.lng, ts: r.ts,
    photos: { front: r.photo_front, back: r.photo_back, left: r.photo_left, right: r.photo_right },
    note: r.note || '',
  }));
}

// Bikes a field officer has collected today that the RECEIVER hasn't logged yet — the
// receiver's work queue. Returns [{plate, name, actorName(officer), ts}].
export async function receiverQueue(day) {
  const all = await getTransfers(day);
  const received = new Set(all.filter((t) => t.stage === 'receiver').map((t) => t.plate));
  const seen = new Set();
  const out = [];
  for (const t of all.filter((t) => t.stage === 'field')) {
    if (received.has(t.plate) || seen.has(t.plate)) continue; // already received / dedup
    seen.add(t.plate);
    out.push({ plate: t.plate, name: t.name, collectedBy: t.actorName, ts: t.ts });
  }
  return out;
}
