// Durable roster storage backed by Supabase (Postgres via the PostgREST API).
//
// WHY: on Render's free plan the container filesystem is ephemeral, so a roster
// written to data/officers.json is wiped on every restart/sleep/deploy — officers
// kept "deleting themselves". Supabase lives OUTSIDE Render, so the roster now
// survives everything. Zero new dependencies: we just call the REST API with the
// built-in fetch, using the SECRET service key (server-side only — it bypasses
// row-level security, so it must never reach the browser).
//
// Table (see the SQL run in the Supabase SQL editor):
//   officers(imei text pk, name, area, phone, platform, created_at, updated_at)

import { config } from './config.js';

const { url, key } = config.supabase;

export function supabaseEnabled() {
  return Boolean(url && key);
}

function headers(extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function rest(path, opts = {}) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: headers(opts.headers),
    signal: opts.signal || AbortSignal.timeout(config.httpTimeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Load the whole roster → { imei: { name, area, phone } }.
export async function fetchOfficers() {
  const rows = await rest('officers?select=imei,name,area,phone');
  const map = {};
  for (const o of rows || []) {
    map[String(o.imei)] = { name: o.name || '', area: o.area || '', phone: o.phone || '' };
  }
  return map;
}

// Replace the ENTIRE roster with `map` (matches the file store's wholesale-save
// semantics): upsert everything present, then delete rows no longer in the map.
export async function writeOfficers(map) {
  const entries = Object.entries(map || {});
  const rows = entries.map(([imei, v]) => ({
    imei: String(imei),
    name: (v?.name || '').slice(0, 60),
    area: (v?.area || '').slice(0, 60),
    phone: (v?.phone || '').slice(0, 30),
  }));

  if (rows.length) {
    await rest('officers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  }

  // Remove any officer no longer selected. PostgREST needs an explicit filter;
  // `imei=not.in.(...)` deletes everything except the kept set. With an empty set
  // we clear the table (imei is never null, so `not.is.null` matches all rows).
  const keep = rows.map((r) => r.imei);
  const filter = keep.length
    ? `imei=not.in.(${keep.map((i) => `"${i}"`).join(',')})`
    : 'imei=not.is.null';
  await rest(`officers?${filter}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });

  return map;
}
