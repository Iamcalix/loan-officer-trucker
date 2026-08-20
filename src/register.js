// Customer register: maps a person's NAME (as pasted in the morning follow-list)
// to their bike PLATE, using the ELEGANSKY customer master (seeded into Supabase
// from LMP-with-parent.xlsx). The plate then resolves to live tracker(s) elsewhere.
//
// Names are entered by humans and rarely match character-for-character, so we do
// tolerant token-based matching and, when unsure, return candidates for the user
// to pick from.
//
// Table: customers(plate pk, name, name_norm, phone, parent, grp)

import { supabaseEnabled, sbSelect } from './supa.js';

export function normalizeName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const tokensOf = (norm) => new Set(norm.split(' ').filter(Boolean));

let index = []; // [{ plate, name, phone, grp, norm, tokens }]
let byPlate = new Map();
let loadedAt = 0;

export async function loadRegister() {
  if (!supabaseEnabled()) { index = []; byPlate = new Map(); return index; }
  // PostgREST caps a response at 1000 rows, so page through the whole register.
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbSelect(`customers?select=plate,name,name_norm,phone,grp&order=plate&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  index = rows.map((r) => {
    const norm = r.name_norm || normalizeName(r.name);
    return { plate: r.plate, name: r.name, phone: r.phone || '', grp: r.grp || '', norm, tokens: tokensOf(norm) };
  });
  byPlate = new Map(index.map((r) => [r.plate, r]));
  loadedAt = Date.now();
  return index;
}

export function registerSize() { return index.length; }
export function registerLoadedAt() { return loadedAt; }
export function customerByPlate(plate) { return byPlate.get(String(plate)) || null; }

// Jaccard overlap of two token sets.
function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}

// Score a register row against the entered (normalized) name + its tokens.
// Returns 0..1; higher is better. Tuned so exact/one-name-off matches rank first.
function score(entryNorm, entryTokens, row) {
  if (row.norm === entryNorm) return 1;
  const a = entryTokens, b = row.tokens;
  // Containment either way: the entered name is inside the register name, OR the
  // register name is inside the entered name (register often stores a shorter
  // 2-name version of a 3-name customer). Both mean "same person, one extra token".
  let allIn = true; for (const t of a) if (!b.has(t)) { allIn = false; break; }   // entered ⊆ register
  let allRev = true; for (const t of b) if (!a.has(t)) { allRev = false; break; } // register ⊆ entered
  const j = jaccard(a, b);
  if ((allIn || allRev) && Math.min(a.size, b.size) >= 2) return 0.9 + 0.1 * j;   // strong: one name contains the other
  if (allIn && a.size === 1) return 0.6 + 0.2 * j;     // single-name entry — weak, needs confirm
  return j;                                            // partial overlap
}

// Best matches for a raw name → [{ plate, name, phone, grp, score }] sorted desc.
export function matchCandidates(raw, limit = 5) {
  const norm = normalizeName(raw);
  if (!norm) return [];
  const tokens = tokensOf(norm);
  const scored = [];
  for (const row of index) {
    const s = score(norm, tokens, row);
    if (s > 0) scored.push({ plate: row.plate, name: row.name, phone: row.phone, grp: row.grp, score: Number(s.toFixed(3)) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

// If the raw text contains a plate that's in the register, that's the surest match
// — the user typed the plate right in the name (e.g. "AMINA ABDALLAH ALLY MC880FVJ").
export function plateInText(raw) {
  for (const m of String(raw || '').toUpperCase().matchAll(/M[A-Z]?\d{3}[A-Z]{2,4}/g)) {
    const p = m[0].replace(/[^A-Z0-9]/g, '');
    const row = byPlate.get(p);
    if (row) return { plate: row.plate, name: row.name, phone: row.phone, grp: row.grp, score: 1 };
  }
  return null;
}

// A confident single match, or null. Confident = a plate embedded in the text, an
// exact name match, or top score ≥ 0.9 clearly ahead of the runner-up (ambiguous
// names fall through to manual pick instead of mapping to the wrong customer).
export function bestMatch(raw) {
  const byPlate = plateInText(raw);
  if (byPlate) return byPlate;
  const c = matchCandidates(raw, 2);
  if (!c.length) return null;
  const top = c[0];
  const runnerUp = c[1]?.score || 0;
  if (top.score >= 1) return top;                                        // exact name match wins
  if (top.score >= 0.9 && (c.length === 1 || top.score - runnerUp >= 0.05)) return top;
  return null;
}
