// Loan-officer COLLECTION report — the "open vs collected" performance table
// (per the format ELEGANSKY uses): one row per loan officer, grouped by BOOK
// (iPhone / Daily Loan), with book subtotals and a grand total.
//
// Source: the ERP "session puller" Supabase `daily_officer_snapshot` (same project
// wired in as the mapping DB). Column mapping:
//   Open Amount  = total_invoice_amount
//   N. Boda      = open_invoice_count
//   Collection   = today_invoice_collection + arrear_collected   (posted payments)
//   Remain       = Open - Collection
//   % Coll       = Collection / Open
//   Status       = Remain <= 0 (collected >= open) -> GOOD, else BAD
//   Book         = iPhone if the officer/product is iPhone, else Daily Loan
//
// NOTE: this is only as current as the ERP snapshot — the pipeline must be running
// for live daily numbers. `asOf` is surfaced so a stale snapshot is obvious.

import { config } from './config.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isIphone = (name) => /iphone/i.test(String(name || ''));

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

// Build the collection report for a date (defaults to the latest snapshot available).
export async function buildCollection(date) {
  let day = date;
  if (!day) {
    const latest = await erp('daily_officer_snapshot?select=date&order=date.desc&limit=1');
    day = latest[0]?.date || null;
  }
  if (!day) return { asOf: null, books: [], total: null, stale: true };

  const rows = await erp(`daily_officer_snapshot?date=eq.${day}&select=officer_name,total_invoice_amount,open_invoice_count,today_invoice_collection,arrear_collected&order=total_invoice_amount.desc`);

  const mk = (r) => {
    const open = num(r.total_invoice_amount);
    const collection = num(r.today_invoice_collection) + num(r.arrear_collected);
    const remain = open - collection;
    return {
      officer: r.officer_name || '(unnamed)',
      book: isIphone(r.officer_name) ? 'iPhone' : 'Daily Loan',
      open, boda: num(r.open_invoice_count), collection, remain,
      pct: open > 0 ? (collection / open) * 100 : 0,
      status: remain <= 0 && open > 0 ? 'GOOD' : 'BAD',
    };
  };
  const officers = rows.map(mk);

  // Group into books, each with a subtotal; then a grand total.
  const order = ['iPhone', 'Daily Loan'];
  const books = [];
  for (const b of order) {
    const list = officers.filter((o) => o.book === b);
    if (!list.length) continue;
    books.push({ book: b, officers: list, subtotal: subtotal(list, b) });
  }
  return { asOf: day, books, total: subtotal(officers, 'ALL'), stale: isStale(day) };
}

function subtotal(list, label) {
  const open = list.reduce((s, o) => s + o.open, 0);
  const collection = list.reduce((s, o) => s + o.collection, 0);
  const boda = list.reduce((s, o) => s + o.boda, 0);
  const remain = open - collection;
  return { label, open, boda, collection, remain, pct: open > 0 ? (collection / open) * 100 : 0, status: remain <= 0 && open > 0 ? 'GOOD' : 'BAD' };
}

function isStale(day) {
  // EAT "today" vs the snapshot date — flag if the snapshot isn't from today.
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return day !== today;
}
