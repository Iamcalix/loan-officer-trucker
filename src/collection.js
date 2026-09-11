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

async function erp(pathAndQuery) {
  const { url, key } = config.mapDb;
  if (!url || !key) throw new Error('ERP mapping DB not configured');
  const r = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  if (!r.ok) throw new Error(`ERP ${r.status}`);
  return r.json();
}

// Each customer's overdue from the latest ERP arrears snapshot → normName → overdue.
async function overdueByName() {
  const snap = (await erp('arrears_snapshots?select=as_of,data&order=as_of.desc&limit=1'))[0];
  const byName = new Map();
  for (const r of (snap?.data || [])) {
    if (String(r.status).toLowerCase() !== 'overdue') continue;
    const leaf = normName(r.customerLeaf || String(r.customer || '').split(':').pop());
    if (leaf) byName.set(leaf, (byName.get(leaf) || 0) + num(r.balance));
  }
  return { asOf: snap?.as_of || null, byName };
}

export async function buildCollection(date) {
  const day = date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [{ asOf, byName }, paidByPlate] = await Promise.all([
    overdueByName().catch(() => ({ asOf: null, byName: new Map() })),
    paymentsByPlate(date).catch(() => new Map()),
  ]);

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
      const ov = byName.get(normName(it.name || it.enteredName)) || 0; // ERP overdue
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
