// Tiny shared Supabase REST helper (PostgREST). Used by the roster store, the
// customer register, and the daily follow-list. Secret service key, server-side
// only. Zero dependencies — just the built-in fetch.

import { config } from './config.js';

const { url, key } = config.supabase;

export function supabaseEnabled() {
  return Boolean(url && key);
}

// Low-level call. `path` is everything after /rest/v1/ (table + query string).
export async function sb(path, opts = {}) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...opts.headers },
    signal: opts.signal || AbortSignal.timeout(config.httpTimeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path.split('?')[0]} -> ${r.status} ${text.slice(0, 200)}`);
  return { text, json: text ? JSON.parse(text) : null, headers: r.headers };
}

// Convenience helpers.
export const sbSelect = (path) => sb(path).then((r) => r.json || []);

export const sbInsert = (table, rows, { upsert = false } = {}) =>
  sb(table, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: `${upsert ? 'resolution=merge-duplicates,' : ''}return=minimal`,
    },
    body: JSON.stringify(rows),
  });

export const sbDelete = (pathWithFilter) =>
  sb(pathWithFilter, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
