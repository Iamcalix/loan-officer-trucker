// Daily follow-list: the customers each officer is supposed to follow on a given
// day. Imported each morning by pasting names per officer; names are resolved to
// register plates so the map can highlight them and the day report can tell who
// was / wasn't visited.
//
// Table: assignments(id, day, officer_imei, entered_name, plate, matched, created_at)

import { supabaseEnabled, sb, sbSelect, sbInsert, sbDelete } from './supa.js';
import { bestMatch, customerByPlate } from './register.js';

// Pasted follow-lists carry the customer's OVERDUE amount next to the name — either
// tab-separated (name<TAB>amount<TAB>…) or trailing ("SAIDI ATHUMANI ALLY 59,000.00").
// Split it into the clean name (for matching) AND the amount (the customer's Open /
// overdue, used by the collection report).
export function parseImportedRow(raw) {
  let s = String(raw || '').trim();
  let amount = 0;
  if (s.includes('\t')) {
    const parts = s.split('\t').map((x) => x.trim());
    s = parts[0];
    for (let i = parts.length - 1; i >= 1; i--) { const n = Number(parts[i].replace(/[^\d.]/g, '')); if (n > 0) { amount = n; break; } }
  } else {
    const m = s.match(/[\s,;|-]+([\d][\d.,]*)\s*$/);
    if (m) { amount = Number(m[1].replace(/[^\d.]/g, '')) || 0; s = s.slice(0, m.index).trim(); }
  }
  return { name: s.trim(), amount };
}
export function cleanImportedName(raw) { return parseImportedRow(raw).name; }

// Resolve a list of pasted names for one officer, REPLACING that officer's list
// for the day. Returns the resolution so the UI can show matched vs unmatched.
export async function saveAssignments(day, officerImei, names) {
  const seen = new Set();
  const rows = [];
  const matched = [];
  const unmatched = [];
  for (const raw of names) {
    const { name: entered, amount } = parseImportedRow(raw);
    if (!entered) continue;
    const dedupKey = entered.toUpperCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const hit = bestMatch(entered);
    rows.push({ day, officer_imei: String(officerImei), entered_name: entered.slice(0, 120), plate: hit?.plate || null, matched: Boolean(hit), amount: amount || null });
    if (hit) matched.push({ entered, plate: hit.plate, name: hit.name, phone: hit.phone, amount });
    else unmatched.push(entered);
  }

  if (supabaseEnabled()) {
    // GUARD: never let an empty submission wipe an existing list. A blank/failed
    // paste (or a mis-click in the modal) would otherwise delete-then-insert-nothing
    // and silently erase the officer's whole day. Saving requires at least one name;
    // to genuinely clear a list, delete it explicitly.
    if (!rows.length) {
      return { day, officerImei, total: 0, matched, unmatched, skipped: 'empty — existing list left untouched' };
    }
    await sbDelete(`assignments?day=eq.${day}&officer_imei=eq.${encodeURIComponent(officerImei)}`);
    try {
      await sbInsert('assignments', rows);
    } catch (e) {
      // `amount` column may not exist yet (run the ALTER once) — degrade gracefully so
      // saving still works; amounts just won't persist until the column is added.
      await sbInsert('assignments', rows.map(({ amount, ...r }) => r));
    }
  }
  return { day, officerImei, total: rows.length, matched, unmatched };
}

// Manually map one entered name to a plate (used to fix an unmatched row).
export async function setAssignmentPlate(day, officerImei, enteredName, plate) {
  if (!supabaseEnabled()) return { ok: false };
  await sbDelete(`assignments?day=eq.${day}&officer_imei=eq.${encodeURIComponent(officerImei)}&entered_name=eq.${encodeURIComponent(enteredName)}`);
  await sbInsert('assignments', [{ day, officer_imei: String(officerImei), entered_name: enteredName.slice(0, 120), plate: plate || null, matched: Boolean(plate) }]);
  return { ok: true };
}

// All assignments for a day → [{ officerImei, enteredName, plate, matched, name, phone, comment }].
// select=* so a missing `comment` column (before its ALTER) degrades gracefully.
export async function getAssignments(day) {
  if (!supabaseEnabled()) return [];
  const rows = await sbSelect(`assignments?day=eq.${day}&select=*`);
  return rows.map((r) => {
    const cust = r.plate ? customerByPlate(r.plate) : null;
    return {
      officerImei: String(r.officer_imei),
      enteredName: r.entered_name,
      plate: r.plate || null,
      matched: Boolean(r.matched),
      name: cust?.name || r.entered_name,
      phone: cust?.phone || '',
      comment: r.comment || '',
      amount: r.amount != null ? Number(r.amount) : 0, // pasted overdue = Open
    };
  });
}

// Save/clear a free-text comment on one assigned customer for the day.
export async function setComment(day, officerImei, enteredName, comment) {
  if (!supabaseEnabled()) return { ok: false };
  await sb(`assignments?day=eq.${day}&officer_imei=eq.${encodeURIComponent(officerImei)}&entered_name=eq.${encodeURIComponent(enteredName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ comment: String(comment || '').slice(0, 500) }),
  });
  return { ok: true };
}

// day → Map(plate → [officerImei,...]) for map highlighting.
export async function assignedPlatesForDay(day) {
  const rows = await getAssignments(day);
  const map = new Map();
  for (const r of rows) {
    if (!r.plate) continue;
    if (!map.has(r.plate)) map.set(r.plate, []);
    map.get(r.plate).push(r.officerImei);
  }
  return map;
}
