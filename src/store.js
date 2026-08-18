// Durable roster storage backed by Supabase (Postgres via PostgREST).
//
// WHY: on Render's free plan the container filesystem is ephemeral, so a roster
// written to data/officers.json is wiped on every restart/sleep/deploy — officers
// kept "deleting themselves". Supabase lives OUTSIDE Render, so the roster now
// survives everything.
//
// Table: officers(imei text pk, name, area, phone, platform, created_at, updated_at)

import { supabaseEnabled, sbSelect, sbInsert, sbDelete } from './supa.js';

export { supabaseEnabled };

// Load the whole roster → { imei: { name, area, phone } }.
export async function fetchOfficers() {
  const rows = await sbSelect('officers?select=imei,name,area,phone');
  const map = {};
  for (const o of rows) map[String(o.imei)] = { name: o.name || '', area: o.area || '', phone: o.phone || '' };
  return map;
}

// Replace the ENTIRE roster with `map` (wholesale save): upsert everything
// present, then delete rows no longer in the map.
export async function writeOfficers(map) {
  const rows = Object.entries(map || {}).map(([imei, v]) => ({
    imei: String(imei),
    name: (v?.name || '').slice(0, 60),
    area: (v?.area || '').slice(0, 60),
    phone: (v?.phone || '').slice(0, 30),
  }));

  if (rows.length) await sbInsert('officers', rows, { upsert: true });

  const keep = rows.map((r) => r.imei);
  const filter = keep.length
    ? `imei=not.in.(${keep.map((i) => `"${i}"`).join(',')})`
    : 'imei=not.is.null';
  await sbDelete(`officers?${filter}`);
  return map;
}
