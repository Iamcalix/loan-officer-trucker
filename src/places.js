// Known places the officer can be at: the office and the customers. A fix is
// "at" a place when it falls inside that place's radius. Customers come from
// data/customers.json (hot-reloaded) so you can populate them from your register
// or from the customer bikes' live GPS without a redeploy:
//   [{ "id": "C123", "name": "Asha M.", "phone": "+255...", "lat": -6.8, "lng": 39.2 }]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.CUSTOMERS_FILE || path.join(__dirname, '..', 'data', 'customers.json');

export function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

let customers = [];
let mtime = 0;

function loadCustomers() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs !== mtime) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      customers = (Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...v })))
        .map((c) => ({ ...c, lat: Number(c.lat), lng: Number(c.lng) }))
        .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
      mtime = st.mtimeMs;
    }
  } catch {
    customers = [];
  }
  return customers;
}

// Live customer positions can be injected (e.g. from the customers' own bike
// trackers) to override/augment the static file. Map<id, {name,phone,lat,lng}>.
let liveCustomers = null;
export function setLiveCustomers(list) {
  liveCustomers = (list || []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
}

function allCustomers() {
  return liveCustomers && liveCustomers.length ? liveCustomers : loadCustomers();
}

export function officePlace() {
  const o = config.office;
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null;
  return { type: 'office', id: 'OFFICE', name: o.name, lat: o.lat, lng: o.lng, radiusM: o.radiusM };
}

// Classify a single point: the nearest place whose radius contains it, or null.
export function classify(pt) {
  if (!Number.isFinite(pt?.lat) || !Number.isFinite(pt?.lng)) return null;
  let best = null;
  const office = officePlace();
  if (office) {
    const d = haversineM(pt, office);
    if (d <= office.radiusM) best = { type: 'office', id: 'OFFICE', name: office.name, distM: d };
  }
  const r = config.proximity.customerRadiusM;
  for (const c of allCustomers()) {
    const d = haversineM(pt, c);
    if (d <= r && (!best || d < best.distM)) {
      best = { type: 'customer', id: c.id, name: c.name || c.id, phone: c.phone || null, distM: d };
    }
  }
  return best;
}

export function customerCount() { return allCustomers().length; }
