// Read-only Wanway / IoP Open API client (open.iopgps.com), adapted from the
// proven smart-collector integration. This app only READS positions — there is
// deliberately NO cut/restore/relay command path here (field officers are people,
// not repossessable assets).
//
// Contract:
//   authenticate()                 -> caches a ~2h accessToken
//   listDevices()                  -> [{ imei, name, raw }]           (names for the map)
//   liveLocations()                -> [{ imei, lat, lng }]            (whole org, one call)
//   location(imei)                 -> { lat, lng, address, gpsTime }  (single, with address)
//   status(imei)                   -> { online, accOn, speedKmh, ageSec, gpsSec }
//   history(imei, startSec, endSec)-> [{ lat, lng, speed, course, accOn, gpsSec, positionType }]
//
// Auth: POST /api/auth { appid, time:<unix s>, signature: md5(md5(secret)+time) }
//        -> { code, accessToken, expiresIn }. Token then rides in the `accessToken` header.

import crypto from 'node:crypto';
import { config } from './config.js';

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

function plateFromName(name) {
  // Wanway names a device "<NAME> <index>" (e.g. "OFFICER-JOHN 1"). Drop a
  // trailing " <digits>" so the display name is clean.
  return String(name || '').replace(/\s+\d+\s*$/, '').trim();
}

export function createGpsClient() {
  const base = config.wanway.base;
  const { appid, secret } = config.wanway;
  if (!appid || !secret) throw new Error('Wanway appid/secret missing (WANWAY_APPID / WANWAY_API_KEY).');

  let token = null;
  let tokenExp = 0; // epoch ms the cached token goes stale

  async function getJson(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      signal: opts.signal || AbortSignal.timeout(config.httpTimeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, json, text };
  }

  async function ensureToken() {
    // Auth is rate-limited (~2/min) and the token lives ~2h — reuse it, refreshing
    // ~5 min early.
    if (token && Date.now() < tokenExp - 5 * 60_000) return token;
    return self.authenticate();
  }

  // Authenticated GET; refreshes the token once on an expired-token failure.
  async function call(path, retry = true) {
    const t = await ensureToken();
    const res = await getJson(`${base}${path}`, { headers: { accessToken: t } });
    const code = res.json?.code;
    if (retry && (res.status === 401 || code === 401 || /token/i.test(res.json?.result || ''))) {
      token = null;
      return call(path, false);
    }
    return res;
  }

  const self = {
    async authenticate() {
      const time = Math.floor(Date.now() / 1000);
      const signature = md5(md5(secret) + time);
      const res = await getJson(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid, time, signature }),
      });
      if (res.json?.code !== 0 || !res.json?.accessToken) {
        throw new Error(`Wanway auth failed: ${res.json?.result || res.text.slice(0, 160)}`);
      }
      token = res.json.accessToken;
      tokenExp = Date.now() + (Number(res.json.expiresIn) || 7200_000);
      return token;
    },

    // Every account id in the org tree (parent + nested sub-accounts). Devices are
    // spread across sub-accounts, so the top level alone misses most. [null] if the
    // tree can't be read (fall back to the token's own view).
    async _accountIds() {
      const res = await call('/api/account/tree');
      const ids = [];
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.accountId != null) ids.push(n.accountId);
        for (const c of n.childAccounts || []) walk(c);
      })(res.json);
      return ids.length ? ids : [null];
    },

    // Device roster (paged, 100/page) across all accounts → imei→name.
    async listDevices() {
      let ids;
      try { ids = await this._accountIds(); } catch { ids = [null]; }
      const byImei = new Map();
      for (const id of ids) {
        let page = 1;
        for (let guard = 0; guard < 50; guard++) {
          const q = `currentPage=${page}&pageSize=100` + (id != null ? `&id=${id}` : '');
          const res = await call(`/api/device?${q}`);
          if (res.json?.code !== 0) break;
          const rows = res.json.data || [];
          for (const d of rows) {
            const imei = String(d.imei || '').trim();
            if (!imei || byImei.has(imei)) continue;
            // Wanway's device roster carries no last-fix timestamp (only
            // activate/expiry times), so freshness for Wanway bikes comes from the
            // live feed instead — lastFixMs stays null here for interface parity.
            byImei.set(imei, { imei, name: plateFromName(d.deviceName), lastFixMs: null, raw: d });
          }
          const total = Number(res.json.page?.count) || 0;
          if (page * 100 >= total || rows.length === 0) break;
          page += 1;
        }
      }
      return [...byImei.values()];
    },

    // One call for the whole fleet's current positions — the live-map workhorse.
    async liveLocations() {
      const parts = [`isTakeSub=${config.wanway.isTakeSub}`];
      if (config.wanway.accountId) parts.push(`accountId=${encodeURIComponent(config.wanway.accountId)}`);
      const res = await call(`/api/device/locations/search-by-organization?${parts.join('&')}`);
      const rows = res.json?.data || [];
      const now = Math.floor(Date.now() / 1000);
      return rows
        .map((o) => {
          const gs = Number(o.gpsTime); // Wanway gpsTime is unix seconds
          return {
            imei: String(o.imei || '').trim(), lat: Number(o.lat), lng: Number(o.lng),
            speed: Number.isFinite(Number(o.speed)) ? Number(o.speed) : null,
            ageSec: Number.isFinite(gs) && gs > 0 ? Math.max(0, now - gs) : null,
          };
        })
        .filter((o) => o.imei && Number.isFinite(o.lat) && Number.isFinite(o.lng));
    },

    // Single device's current position, WITH a reverse-geocoded address.
    async location(imei) {
      const res = await call(`/api/device/location?imei=${encodeURIComponent(imei)}`);
      const o = res.json || {};
      return {
        imei: String(imei),
        lat: Number(o.lat),
        lng: Number(o.lng),
        address: o.address || '',
        gpsTime: Number(o.gpsTime) || null,
      };
    },

    async status(imei) {
      const res = await call(`/api/device/status?imei=${encodeURIComponent(imei)}`);
      const o = res.json?.data?.[0] || (res.json?.imei ? res.json : null);
      if (!o) return { imei: String(imei), online: false, accOn: null, speedKmh: null, ageSec: null, gpsSec: null };
      const now = Math.floor(Date.now() / 1000);
      const signalSec = Number(o.signalTime);
      const gpsSec = Number(o.gpsTime);
      const speedKmh = Number(o.speed);
      return {
        imei: String(o.imei || imei),
        online: Number.isFinite(signalSec) ? now - signalSec < config.offlineAfterMin * 60 : false,
        accOn: o.accStatus == null ? null : Boolean(o.accStatus),
        speedKmh: Number.isFinite(speedKmh) ? speedKmh : null,
        ageSec: Number.isFinite(gpsSec) ? Math.max(0, now - gpsSec) : null,
        gpsSec: Number.isFinite(gpsSec) ? gpsSec : null,
      };
    },

    // Ordered route points between two unix-second timestamps → route replay.
    async history(imei, startSec, endSec) {
      const parts = [`imei=${encodeURIComponent(imei)}`, `startTime=${Math.floor(startSec)}`];
      if (endSec) parts.push(`endTime=${Math.floor(endSec)}`);
      const res = await call(`/api/device/track/history?${parts.join('&')}`);
      const rows = res.json?.data || [];
      return rows
        .map((o) => ({
          lat: Number(o.lat),
          lng: Number(o.lng),
          speed: Number(o.speed) || 0,
          course: Number(o.course) || 0,
          accOn: o.accStatus == null ? null : Boolean(o.accStatus),
          positionType: o.positionType || '',
          gpsSec: Number(o.gpsTime) || null,
        }))
        .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng))
        .sort((a, b) => (a.gpsSec || 0) - (b.gpsSec || 0));
    },
  };

  return self;
}
