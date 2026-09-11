// Live bank-payments reader — the same Google Sheet the smart-collector polls.
// Payments land in the PASSED tab within ~5 min of the bank deposit, so this is
// the current "customer paid" source (the ERP payment mirror is dead). Zero deps:
// a service-account JWT (RS256, node:crypto) → OAuth token → Sheets v4 read-only.
//
// PASSED tab columns (0-based): date=B(1) "DD.MM.YYYY", amount=E(4), plate=F(5).
// Env: GOOGLE_SA_JSON (inline service-account JSON), PAYMENTS_SHEET_ID.

import crypto from 'node:crypto';
import { config } from './config.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])\d+$/, '$1');
const parseAmount = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || 0;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

let _sa = null, _token = null;
function sa() {
  if (_sa) return _sa;
  if (!config.paysheet.saJson) throw new Error('GOOGLE_SA_JSON not set');
  _sa = JSON.parse(config.paysheet.saJson);
  return _sa;
}
async function token() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _token.exp - 60 > now) return _token.t;
  const s = sa();
  const claim = { iss: s.client_email, scope: SCOPE, aud: s.token_uri, iat: now, exp: now + 3600 };
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(s.private_key).toString('base64url');
  const res = await fetch(s.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${sig}`,
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`google token ${res.status}`);
  _token = { t: d.access_token, exp: now + (Number(d.expires_in) || 3600) };
  return _token.t;
}

async function readRange(range) {
  const id = config.paysheet.sheetId;
  if (!id) throw new Error('PAYMENTS_SHEET_ID not set');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(config.httpTimeoutMs) });
  if (!res.ok) throw new Error(`sheets ${res.status}`);
  return (await res.json()).values || [];
}

export function paysheetEnabled() { return Boolean(config.paysheet.saJson && config.paysheet.sheetId); }

// DD.MM.YYYY for EAT today / yesterday (payments post same/next day).
const fmtEat = (t) => `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${t.getUTCFullYear()}`;

// Map normPlate -> amount paid on `day` (and yesterday, for late-posted deposits).
// Cached briefly so a burst of report loads shares one read.
let _cache = { at: 0, key: '', map: new Map() };
export async function paymentsByPlate(day) {
  if (!paysheetEnabled()) return new Map();
  const d = new Date(Date.now() + 3 * 3600 * 1000); // EAT
  const today = fmtEat(d), yest = fmtEat(new Date(d.getTime() - 24 * 3600e3));
  const key = day || today;
  if (_cache.key === key && Date.now() - _cache.at < 120_000) return _cache.map;
  const { col, tab } = config.paysheet;
  const rows = await readRange(`${tab}!A2:H`);
  const want = day ? new Set([day]) : new Set([today, yest]);
  const map = new Map();
  for (const r of rows) {
    const rd = String(r[col.date] ?? '').trim();
    if (![...want].some((w) => rd.startsWith(w))) continue;
    const p = normPlate(r[col.plate]);
    if (!p) continue;
    map.set(p, (map.get(p) || 0) + parseAmount(r[col.amount]));
  }
  _cache = { at: Date.now(), key, map };
  return map;
}
