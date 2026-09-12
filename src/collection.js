// FIELD-officer collection report — open vs collected per field officer, in the
// ELEGANSKY format (Open Amount · N. Boda · Collection · Remain · % Coll · Status).
//
// Rows = the field officers. For the customers on their daily follow-list:
//   Open Amount = Σ the OVERDUE amount pasted with each customer on the follow-list
//                 (temporary; switches back to the live ERP arrears feed later)
//   N. Boda     = number of assigned customers
//   Collection  = Σ payments today for their plates  (LIVE bank-payments sheet)
//   Remain      = Open − Collection ; % Coll = Collection/Open
//   Status      = Remain ≤ 0 → GOOD, else BAD

import { officerImeis, officerFor } from './officers.js';
import { getAssignments } from './assignments.js';
import { paymentsByPlate, paysheetEnabled } from './paysheet.js';
import { customerByPlate } from './register.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export async function buildCollection(date) {
  const day = date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const paidByPlate = await paymentsByPlate(date).catch(() => new Map()); // LIVE, by plate
  // Also index payments by customer NAME (resolve each paid plate through the register),
  // so a follow-list customer who paid under a DIFFERENT plate than their assigned one
  // is still posted. Every payment that belongs to a follow-list customer counts.
  const paidByName = new Map();
  for (const [plate, amt] of paidByPlate) {
    const c = customerByPlate(plate);
    if (c?.name) { const nm = normName(c.name); paidByName.set(nm, (paidByName.get(nm) || 0) + amt); }
  }

  const assignments = await getAssignments(day).catch(() => []);
  const byOfficer = new Map();
  for (const a of assignments) {
    if (!byOfficer.has(a.officerImei)) byOfficer.set(a.officerImei, []);
    byOfficer.get(a.officerImei).push(a);
  }

  const usedPlate = new Set();       // avoid crediting the same payment twice
  const officers = [];
  for (const imei of officerImeis()) {
    const items = byOfficer.get(imei) || [];
    if (!items.length) continue;
    let open = 0, collection = 0, withAmount = 0, paidCount = 0;
    for (const it of items) {
      const amt = Number(it.amount) || 0;                       // Open = pasted overdue
      if (amt > 0) { open += amt; withAmount += 1; }
      // Collection: this customer's payment today — by plate, else by name.
      const pl = it.plate ? normPlate(it.plate) : '';
      let pd = pl && paidByPlate.has(pl) && !usedPlate.has(pl) ? paidByPlate.get(pl) : 0;
      if (pd) usedPlate.add(pl);
      else pd = paidByName.get(normName(it.name || it.enteredName)) || 0;
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

  // Diagnostic: sheet payments matched to a follow-list customer (plate or name) vs not.
  const assignedPlates = new Set(), assignedNames = new Set();
  for (const items of byOfficer.values()) for (const it of items) {
    if (it.plate) assignedPlates.add(normPlate(it.plate));
    assignedNames.add(normName(it.name || it.enteredName));
  }
  let matched = 0; const unmatchedSample = [];
  for (const p of paidByPlate.keys()) {
    const nm = normName(customerByPlate(p)?.name || '');
    if (assignedPlates.has(p) || (nm && assignedNames.has(nm))) matched += 1;
    else if (unmatchedSample.length < 15) unmatchedSample.push(p);
  }
  const payDebug = { platesPaidInSheet: paidByPlate.size, matchedToFollowList: matched, unmatchedSample };

  return { day, officers, total: total(officers), payLive: paysheetEnabled(), payDebug };
}

function total(list) {
  const open = list.reduce((s, o) => s + o.open, 0);
  const collection = list.reduce((s, o) => s + o.collection, 0);
  const boda = list.reduce((s, o) => s + o.boda, 0);
  const remain = open - collection;
  return { label: 'TOTAL — all field officers', boda, open, collection, remain, pct: open > 0 ? (collection / open) * 100 : 0, status: open > 0 && remain <= 0 ? 'GOOD' : 'BAD' };
}
