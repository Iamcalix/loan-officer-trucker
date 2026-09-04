// Daily follow-list: the customers each officer is supposed to follow on a given
// day. Imported each morning by pasting names per officer; names are resolved to
// register plates so the map can highlight them and the day report can tell who
// was / wasn't visited.
//
// Table: assignments(id, day, officer_imei, entered_name, plate, matched, created_at)

import { supabaseEnabled, sb, sbSelect, sbInsert, sbDelete } from './supa.js';
import { bestMatch, customerByPlate } from './register.js';

// Pasted follow-lists often carry extra columns (name<TAB>amount<TAB>officer) or a
// trailing amount ("SAIDI ATHUMANI ALLY 59,000.00"). Keep just the name so matching
// isn't polluted by numbers/other fields.
export function cleanImportedName(raw) {
  let s = String(raw || '').trim();
  if (s.includes('\t')) s = s.split('\t')[0];       // keep the first (name) column
  s = s.replace(/[\s,;|-]+[\d][\d.,]*\s*$/, '');     // drop a trailing amount like "59,000.00"
  return s.trim();
}

// Resolve a list of pasted names for one officer, REPLACING that officer's list
// for the day. Returns the resolution so the UI can show matched vs unmatched.
export async function saveAssignments(day, officerImei, names) {
  const seen = new Set();
  const rows = [];
  const matched = [];
  const unmatched = [];
  for (const raw of names) {
    const entered = cleanImportedName(raw);
    if (!entered) continue;
    const dedupKey = entered.toUpperCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const hit = bestMatch(entered);
    rows.push({ day, officer_imei: String(officerImei), entered_name: entered.slice(0, 120), plate: hit?.plate || null, matched: Boolean(hit) });
    if (hit) matched.push({ entered, plate: hit.plate, name: hit.name, phone: hit.phone });
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
    await sbInsert('assignments', rows);
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
