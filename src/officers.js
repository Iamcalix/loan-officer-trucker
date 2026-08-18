// IMEI -> officer identity mapping (the field-officer roster).
//
// Storage is DURABLE via Supabase when configured (SUPABASE_URL/SUPABASE_KEY) —
// this is what stops officers from vanishing on Render's ephemeral free-plan disk.
// Without Supabase it falls back to the local data/officers.json file (fine for
// local dev). Reads are served from an in-memory cache so the hot paths (map
// snapshot, geofence) stay synchronous; the cache is seeded at startup by
// initRoster() and updated on every save.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseEnabled, fetchOfficers, writeOfficers } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.OFFICERS_FILE || path.join(__dirname, '..', 'data', 'officers.json');

let cache = {};

// ---- file fallback (used only when Supabase is not configured) ----
function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function writeFile(map) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
}

// Seed the in-memory cache from durable storage. Call once at startup (and
// periodically) so reads are instant and never touch the network.
export async function initRoster() {
  if (supabaseEnabled()) {
    try {
      cache = await fetchOfficers();
    } catch (e) {
      // Don't crash the server if Supabase is briefly unreachable — keep whatever
      // we had (empty on first boot) and try again on the next refresh.
      console.error('roster load from Supabase failed:', e.message);
    }
  } else {
    cache = readFile();
  }
  return cache;
}

export function officerFor(imei) {
  return cache[String(imei)] || null;
}

// The set of IMEIs that are field officers. Empty = no roster yet (the app then
// shows every device on the map instead of just officers).
export function officerImeis() {
  return new Set(Object.keys(cache));
}

export function hasRoster() {
  return Object.keys(cache).length > 0;
}

// Persist a new roster (IMEI -> {name, area, phone}) durably, then refresh the
// cache so reads see it immediately. Wholesale replace (matches the picker's
// "these are all the officers now" semantics).
export async function saveRoster(map) {
  if (supabaseEnabled()) {
    await writeOfficers(map);
  } else {
    writeFile(map);
  }
  cache = map;
  return map;
}
