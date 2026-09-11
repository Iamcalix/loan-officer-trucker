// FIELD-officer collection report — open vs collected per field officer, in the
// ELEGANSKY format (Open Amount · N. Boda · Collection · Remain · % Coll · Status).
//
// Rows = the GPS field officers (GOOD, JUMA, RAJABU …). Each field officer's numbers
// come from the customers on their daily follow-list:
//   Open Amount  = Σ overdue of their assigned customers   (ERP arrears)
//   N. Boda      = number of assigned customers
//   Collection   = Σ paid by their assigned customers today (ERP payments)
//   Remain       = Open − Collection ; % Coll = Collection/Open
//   Status       = Remain ≤ 0 → GOOD, else BAD
//
// Match key: the customer NAME on the follow-list ↔ the ERP arrears customer leaf
// (both come from the same ERP source). NOTE: numbers are only as current as the ERP
// feed — arrears/payments must be refreshed for live daily figures (`asOf`/`stale`).

import { config } from './config.js';
import { officerImeis, officerFor } from './officers.js';
import { getAssignments } from './assignments.js';
import { paymentsByPlate, paysheetEnabled } from './paysheet.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');

async function erp(pathAndQuery) {
  const { url, key } = config.mapDb;
  if (!url || !key) throw new Error('ERP mapping DB not configured (MAP_DB_URL/MAP_DB_KEY)');
  const r = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  if (!r.ok) throw new Error(`ERP ${r.status}`);
  return r.json();
}

// Per-customer overdue from the latest arrears snapshot → name→overdue, id→overdue,
// id→name (for joining payments back to a name).
async function loadArrears() {
  const snap = (await erp('arrears_snapshots?select=as_of,data&order=as_of.desc&limit=1'))[0];
  const byName = new Map(), byId = new Map(), idName = new Map();
  for (const r of (snap?.data || [])) {
    if (String(r.status).toLowerCase() !== 'overdue') continue;
    const leaf = normName(r.customerLeaf || String(r.customer || '').split(':').pop());
    const bal = num(r.balance);
    if (leaf) byName.set(leaf, (byName.get(leaf) || 0) + bal);
    if (r.customerId != null) { byId.set(String(r.customerId), (byId.get(String(r.customerId)) || 0) + bal); idName.set(String(r.customerId), leaf); }
  }
  return { asOf: snap?.as_of || null, byName, byId, idName };
}

export async function buildCollection(date) {
  const day = date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  // Open (overdue) — from the pasted follow-list amount if present, else ERP arrears
  // (stale). Collection — LIVE from the bank-payments sheet, matched by PLATE.
  const { asOf, byName } = await loadArrears();
  const paidByPlate = await paymentsByPlate(date).catch(() => new Map());

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
      // Open: pasted amount on the assignment (its overdue) if we have it, else ERP.
      const amt = Number(it.amount) > 0 ? Number(it.amount) : (byName.get(normName(it.name || it.enteredName)) || 0);
      if (amt > 0) { open += amt; matched += 1; }
      // Collection: today's payment for this plate from the live sheet.
      const pd = it.plate ? paidByPlate.get(normPlate(it.plate)) : 0;
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

  return { asOf, day, officers, total: total(officers), stale: asOf !== day, payLive: paysheetEnabled() };
}

function total(list) {
  const open = list.reduce((s, o) => s + o.open, 0);
  const collection = list.reduce((s, o) => s + o.collection, 0);
  const boda = list.reduce((s, o) => s + o.boda, 0);
  const remain = open - collection;
  return { label: 'TOTAL — all field officers', boda, open, collection, remain, pct: open > 0 ? (collection / open) * 100 : 0, status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD' };
}
