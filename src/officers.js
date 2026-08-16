// Optional IMEI -> officer identity mapping. Drop a data/officers.json like:
//   { "863844000000001": { "name": "John M.", "phone": "+2557...", "area": "Kinondoni" } }
// Anything not listed falls back to the tracker's own device name. The file is
// re-read on change so you can update officers without a redeploy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.OFFICERS_FILE || path.join(__dirname, '..', 'data', 'officers.json');

let cache = {};
let mtime = 0;

function reloadIfChanged() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs !== mtime) {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      mtime = st.mtimeMs;
    }
  } catch {
    cache = {}; // no file (or bad JSON) → fall back to device names everywhere
  }
  return cache;
}

export function officerFor(imei) {
  const m = reloadIfChanged();
  return m[String(imei)] || null;
}

// The set of IMEIs that are field officers. Empty = no roster configured yet
// (the app then shows every device on the map instead of just officers).
export function officerImeis() {
  return new Set(Object.keys(reloadIfChanged()));
}

export function hasRoster() {
  return officerImeis().size > 0;
}

// Persist a new roster (IMEI -> {name, area, phone}) to data/officers.json and
// refresh the in-memory cache so reads see it immediately.
export function saveRoster(map) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
  cache = map;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; }
  return map;
}
