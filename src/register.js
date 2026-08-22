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
// Canonical plate key — strips a trailing tracker-index digit ("MC693FML1" → "MC693FML").
const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
const tokensOf = (norm) => norm.split(' ').filter(Boolean);

// Levenshtein edit distance (small strings — cheap).
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3; // early out — too different to be a typo
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}
// Two name tokens are "the same" if equal, or a small misspelling of each other.
// Only tokens ≥5 chars may fuzzy-match (short names like ALLY/SAID must be exact,
// else different people collide); allow 1 edit (2 for long ≥8-char tokens).
function tokenMatch(x, y) {
  if (x === y) return true;
  const L = Math.max(x.length, y.length);
  if (L < 5) return false;
  return lev(x, y) <= (L >= 8 ? 2 : 1);
}

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
    return { plate: r.plate, name: r.name, phone: r.phone || '', grp: r.grp || '', norm, toks: tokensOf(norm) };
  });
  byPlate = new Map(index.map((r) => [normPlate(r.plate), r]));
  loadedAt = Date.now();
  return index;
}

export function registerSize() { return index.length; }
export function registerLoadedAt() { return loadedAt; }
export function customerByPlate(plate) { return byPlate.get(normPlate(plate)) || null; }

// Count matching tokens between two token lists — greedy, each token used once.
// `fuzzy` allows a small misspelling to still count as a match.
function inter(a, b, fuzzy) {
  const used = new Array(b.length).fill(false);
  let n = 0;
  for (const x of a) {
    let bi = -1;
    for (let i = 0; i < b.length; i++) if (!used[i] && b[i] === x) { bi = i; break; }
    if (bi < 0 && fuzzy) for (let i = 0; i < b.length; i++) if (!used[i] && tokenMatch(x, b[i])) { bi = i; break; }
    if (bi >= 0) { used[bi] = true; n += 1; }
  }
  return n;
}

// Score a register row against the entered (normalized) name tokens. 0..1.
// Typo-tolerant, but SAFELY: a misspelling only wins when the two names have the
// SAME token count and every token pairs up (a true misspelling of the same name).
// "One name contains the other" still requires EXACT tokens, so a generic 2-name
// register entry can't fuzzy-swallow a different longer name.
function score(entryNorm, a, row) {
  if (row.norm === entryNorm) return 1;
  const b = row.toks;
  const nFuzzy = inter(a, b, true);
  const nExact = inter(a, b, false);
  const jac = nFuzzy / (a.length + b.length - nFuzzy || 1);
  // Same length + all tokens pair up (typos allowed) → misspelling of the same name.
  if (a.length === b.length && nFuzzy === a.length && a.length >= 2) return 0.95 + 0.05 * jac;
  // Containment (EXACT tokens only): entered ⊆ register or register ⊆ entered.
  const allInExact = nExact === a.length, allRevExact = nExact === b.length;
  if ((allInExact || allRevExact) && Math.min(a.length, b.length) >= 2) {
    return 0.9 + 0.1 * (nExact / (a.length + b.length - nExact || 1));
  }
  if (allInExact && a.length === 1) return 0.6 + 0.2 * jac;   // single-name entry — weak
  return jac;                                                 // partial overlap
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
    const p = normPlate(m[0]);
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
