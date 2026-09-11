// FIELD-officer collection report — open vs collected per field officer, in the
// ELEGANSKY format (Open Amount · N. Boda · Collection · Remain · % Coll · Status).
//
// Rows = the field officers. Numbers come from the customers on their daily
// follow-list:
//   Open Amount = Σ the OVERDUE amount pasted with each customer on the follow-list
//   N. Boda     = number of assigned customers
//   Collection  = Σ payments today for their customers' plates  (LIVE bank-payments sheet)
//   Remain      = Open − Collection ; % Coll = Collection/Open
//   Status      = Remain ≤ 0 → GOOD, else BAD
//
// No ERP dependency and no ≥25k threshold — Open is exactly what the office pastes,
// Collection is live by plate.

import { officerImeis, officerFor } from './officers.js';
import { getAssignments } from './assignments.js';
import { paymentsByPlate, paysheetEnabled } from './paysheet.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');

export async function buildCollection(date) {
  const day = date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const paidByPlate = await paymentsByPlate(date).catch(() => new Map()); // LIVE, by plate

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
    let open = 0, collection = 0, withAmount = 0, paidCount = 0;
    for (const it of items) {
      const amt = Number(it.amount) || 0;      // Open = the pasted overdue amount
      if (amt > 0) { open += amt; withAmount += 1; }
      const pd = it.plate ? paidByPlate.get(normPlate(it.plate)) : 0; // Collection = live payment
      if (pd) { collection += pd; paidCount += 1; }
    }
    const remain = open - collection;
    officers.push({
      officer: officerFor(imei)?.name || imei,
      boda: items.length, withAmount, paidCount, open, collection, remain,
      pct: open > 0 ? (collection / open) * 100 : 0,
      status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD',
    });
  }
  officers.sort((a, b) => b.open - a.open);

  return { day, officers, total: total(officers), payLive: paysheetEnabled() };
}

function total(list) {
  const open = list.reduce((s, o) => s + o.open, 0);
  const collection = list.reduce((s, o) => s + o.collection, 0);
  const boda = list.reduce((s, o) => s + o.boda, 0);
  const remain = open - collection;
  return { label: 'TOTAL — all field officers', boda, open, collection, remain, pct: open > 0 ? (collection / open) * 100 : 0, status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD' };
}
