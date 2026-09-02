// Tiny shared Supabase REST helper (PostgREST). Used by the roster store, the
// customer register, and the daily follow-list. Secret service key, server-side
// only. Zero dependencies — just the built-in fetch.

import { config } from './config.js';

const { url, key } = config.supabase;

export function supabaseEnabled() {
  return Boolean(url && key);
}

// Low-level call. `path` is everything after /rest/v1/ (table + query string).
// Retries transient failures (network timeout / 5xx) so a momentary blip doesn't
// e.g. blank the day report's visits and show a false "0 visited".
export async function sb(path, opts = {}) {
  const attempts = opts.method && opts.method !== 'GET' ? 2 : 3; // reads retry more
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${url}/rest/v1/${path}`, {
        ...opts,
        headers: { apikey: key, Authorization: `Bearer ${key}`, ...opts.headers },
        signal: opts.signal || AbortSignal.timeout(config.httpTimeoutMs),
      });
      const text = await r.text();
      if (r.status >= 500) throw new Error(`Supabase ${r.status}`); // transient — retry
      if (!r.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path.split('?')[0]} -> ${r.status} ${text.slice(0, 200)}`);
      return { text, json: text ? JSON.parse(text) : null, headers: r.headers };
    } catch (e) {
      lastErr = e;
      // Only retry transient errors (timeout/network/5xx), not 4xx client errors.
      if (/-> 4\d\d/.test(String(e.message))) throw e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw lastErr;
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
