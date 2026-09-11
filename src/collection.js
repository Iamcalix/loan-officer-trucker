// FIELD-officer collection report — open vs collected per field officer, in the
// ELEGANSKY format (Open Amount · N. Boda · Collection · Remain · % Coll · Status).
//
// Rows = the field officers. For the customers on their daily follow-list:
//   Open Amount = Σ each customer's OVERDUE pulled from the ERP arrears (by name)
//   N. Boda     = number of assigned customers
//   Collection  = Σ payments today for their plates  (LIVE bank-payments sheet)
//   Remain      = Open − Collection ; % Coll = Collection/Open
//   Status      = Remain ≤ 0 → GOOD, else BAD
//
// No ≥25k threshold — every assigned customer is included with whatever overdue the
// ERP has for them.

import { config } from './config.js';
import { officerImeis, officerFor } from './officers.js';
import { getAssignments } from './assignments.js';
import { paymentsByPlate, paysheetEnabled } from './paysheet.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');

// LIVE overdue from the elegansky-brain ERP arrears API (/arrears/customer). It's on
// Render, so it's reachable from officer-tracker (also Render) but NOT from Tanzania
// (onrender.com SNI block). Returns one pre-aggregated row per customer with plates —
// so we match the follow-list by PLATE (reliable), falling back to name.
// Response: { asOf, customers: [{ customer, total_overdue, plates:[], loan_officer, full_path }] }.
let _arr = { at: 0, byPlate: new Map(), byName: new Map(), asOf: null };
async function loadArrearsApi() {
  if (Date.now() - _arr.at < 5 * 60_000 && (_arr.byPlate.size || _arr.byName.size)) return _arr;
  const r = await fetch(config.arrearsApiUrl, { signal: AbortSignal.timeout(70_000) }); // Render cold-start tolerant
  if (!r.ok) throw new Error(`arrears API ${r.status}`);
  const data = await r.json();
  const byPlate = new Map(), byName = new Map();
  for (const c of (data.customers || [])) {
    const ov = num(c.total_overdue);
    if (ov <= 0) continue;
    const nm = normName(c.customer);
    if (nm) byName.set(nm, (byName.get(nm) || 0) + ov);
    for (const p of (c.plates || [])) { const np = normPlate(p); if (np) byPlate.set(np, (byPlate.get(np) || 0) + ov); }
  }
  _arr = { at: Date.now(), byPlate, byName, asOf: data.asOf || null };
  return _arr;
}

export async function buildCollection(date) {
  const day = date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [arr, paidByPlate] = await Promise.all([
    loadArrearsApi().catch((e) => ({ byPlate: new Map(), byName: new Map(), asOf: null, error: String(e.message || e) })),
    paymentsByPlate(date).catch(() => new Map()),
  ]);
  const asOf = arr.asOf;

  const assignments = await getAssignments(day).catch(() => []);
  const byOfficer = new Map();
  for (const a of assignments) {
    if (!byOfficer.has(a.officerImei)) byOfficer.set(a.officerImei, []);
    byOfficer.get(a.officerImei).push(a);
  }

  const officers = [];
  for (const imei of officerImeis()) {
    const items = byOfficer.get(imei) || [];
    if (!items.length) continue;
    let open = 0, collection = 0, matched = 0, paidCount = 0;
    for (const it of items) {
      // Live overdue: match by PLATE first (the feed carries plates), else by name.
      const ov = (it.plate ? arr.byPlate.get(normPlate(it.plate)) : 0) || arr.byName.get(normName(it.name || it.enteredName)) || 0;
      if (ov > 0) { open += ov; matched += 1; }
      const pd = it.plate ? paidByPlate.get(normPlate(it.plate)) : 0;    // live payment
      if (pd) { collection += pd; paidCount += 1; }
    }
    const remain = open - collection;
    officers.push({
      officer: officerFor(imei)?.name || imei,
      boda: items.length, matched, paidCount, open, collection, remain,
      pct: open > 0 ? (collection / open) * 100 : 0,
      status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD',
    });
  }
  officers.sort((a, b) => b.open - a.open);

  return { day, asOf, officers, total: total(officers), payLive: paysheetEnabled(), stale: asOf !== day };
}

function total(list) {
  const open = list.reduce((s, o) => s + o.open, 0);
  const collection = list.reduce((s, o) => s + o.collection, 0);
  const boda = list.reduce((s, o) => s + o.boda, 0);
  const remain = open - collection;
  return { label: 'TOTAL — all field officers', boda, open, collection, remain, pct: open > 0 ? (collection / open) * 100 : 0, status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD' };
}
