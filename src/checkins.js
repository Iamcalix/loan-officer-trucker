// Photo check-ins — the officer's manual "proof of visit" from the mobile app.
//
// WHY: GPS can't verify a visit when the customer's bike is dark, parked elsewhere,
// or the customer came WITHOUT their bike. So the officer snaps the plate; the phone
// attaches GPS + timestamp; we store the photo and record the visit. This fills the
// gaps GPS leaves — a check-in counts as "Visited (photo)" in the day report.
//
// Storage: the JPEG goes to the Supabase Storage bucket `checkins` (private); metadata
// goes to the `checkins` table. We ALSO write a normal `visits` row so the customer
// counts as visited immediately, with no dependency on report changes.
//
// Table (run once in the Supabase SQL editor):
//   create table if not exists checkins (
//     id bigint generated always as identity primary key,
//     day date not null, officer_imei text not null,
//     customer_plate text, customer_name text,
//     lat double precision, lng double precision, ts bigint not null,
//     photo_path text, created_at timestamptz default now());
//   create index if not exists checkins_day_officer on checkins(day, officer_imei);

import { config } from './config.js';
import { supabaseEnabled, sb, sbSelect } from './supa.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
const eatDay = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10);
const BUCKET = 'checkins';

// Upload a photo buffer to Supabase Storage; returns its object path.
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

// A short-lived signed URL to view a stored photo (bucket is private).
export async function signedPhotoUrl(path, expiresIn = 3600) {
  if (!path) return null;
  const { url, key } = config.supabase;
  try {
    const r = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.signedURL ? `${url}/storage/v1${j.signedURL}` : null;
  } catch { return null; }
}

// Record one photo check-in: store the JPEG, write the checkins row, and write a
// visits row so it counts as visited. `photoBuf` is the raw image bytes.
export async function recordCheckin({ officerImei, plate, name, lat, lng, ts, photoBuf, mime }) {
  if (!supabaseEnabled()) throw new Error('storage not configured');
  const sec = Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Math.floor(Date.now() / 1000);
  const day = eatDay(sec);
  const p = normPlate(plate);
  const hasPos = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  let photoPath = null;
  if (photoBuf && photoBuf.length) {
    photoPath = `${day}/${officerImei}/${p || 'UNK'}-${sec}.jpg`;
    await uploadPhoto(photoPath, photoBuf, mime || 'image/jpeg');
  }

  // checkins row (photo + audit) — best-effort so a missing table never blocks the visit.
  try {
    await sb('checkins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify([{
        day, officer_imei: String(officerImei), customer_plate: p || null, customer_name: name || '',
        lat: hasPos ? Number(lat) : null, lng: hasPos ? Number(lng) : null, ts: sec, photo_path: photoPath,
      }]),
    });
  } catch (e) { console.error('checkins insert failed (table missing?):', e.message); }

  // visits row so the day report counts it as visited right away. start_ts unique per
  // check-in; 60s so it clears the ≥1-min bar.
  await sb('visits?on_conflict=day,officer_imei,customer_plate,start_ts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      day, officer_imei: String(officerImei), customer_plate: p, customer_name: name || '',
      start_ts: sec, end_ts: sec + 60, seconds: 60, lat: hasPos ? Number(lat) : null, lng: hasPos ? Number(lng) : null,
    }]),
  });

  return { ok: true, day, plate: p, photoPath };
}

// Photo check-ins for a day → Map(officerImei -> Map(normPlate -> {ts, photoPath, lat, lng})).
// Lets the report tag a customer "Visited (photo)" and link the picture.
export async function getCheckins(day) {
  if (!supabaseEnabled()) return new Map();
  let rows;
  try {
    rows = await sbSelect(`checkins?day=eq.${day}&select=officer_imei,customer_plate,customer_name,lat,lng,ts,photo_path&order=ts`);
  } catch { return new Map(); }
  const out = new Map();
  for (const r of rows) {
    const imei = String(r.officer_imei);
    if (!out.has(imei)) out.set(imei, new Map());
    out.get(imei).set(normPlate(r.customer_plate), { ts: r.ts, photoPath: r.photo_path, lat: r.lat, lng: r.lng, name: r.customer_name });
  }
  return out;
}
