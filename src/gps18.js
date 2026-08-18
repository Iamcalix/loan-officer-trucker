// Read-only 18gps Open API client (api.18gps.net), adapted from smart-collector's
// proven apiClient.js. The MAJORITY of ELEGANSKY's trackers live on this platform
// (~7,000) — Wanway only sees a slice — so a bike such as MC563EUD is ONLY visible
// here. Like the Wanway client this app READS positions only: there is deliberately
// NO cut/restore/relay path (field officers are people, not repossessable assets).
//
// Contract mirrors gps.js so the two can be merged behind one fleet client:
//   authenticate()                 -> sets mds token + unit id
//   listDevices()                  -> [{ imei, name, raw }]
//   liveLocations()                -> [{ imei, lat, lng }]           (whole org)
//   location(imei)                 -> { imei, lat, lng, address, gpsTime }
//   status(imei)                   -> { imei, online, accOn, speedKmh, ageSec, gpsSec }
//   history(imei, startSec, endSec)-> []   (track playback endpoint not yet wired)
//
// Positions come free in the device batch (getDeviceListByCustomId), so one batch
// read serves listDevices + liveLocations + status + location for the whole fleet.

import { config } from './config.js';

// 18gps names a device by plate plus an index suffix, e.g. "MC563EUD [1]" or
// "MC291EMF (2)". Strip the trailing "[...]"/"(...)"/" <digits>" for a clean plate.
function cleanPlate(s) {
  return String(s || '').replace(/\s*[\[(].*$/, '').replace(/\s+\d+\s*$/, '').trim();
}

// status string, 1-indexed in the 18gps doc: 1 ACC, 3 oilState, 7 mainPower.
function accFromStatus(s) {
  s = String(s || '');
  return s[0] === '1';
}

export function create18gpsClient() {
  const { base, account, password, loginType, timeZone, mapType } = config.gps18;
  if (!account || !password) throw new Error('18gps account/password missing (GPS_LOGIN_USER / GPS_LOGIN_PASS).');

  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`).join('&');

  let mds = null;
  let unitId = null;
  let unitIds = null;           // root + all subordinate unit ids (cached)
  let batch = null;             // Map<imei, raw record>
  let batchAt = 0;
  const BATCH_MS = 60_000;      // reuse one fleet read for a minute

  async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(config.httpTimeoutMs) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, json, text };
  }

  // Call a GetDate method; re-login once on a 403/expired token.
  async function call(params, retry = true) {
    if (!mds) await self.authenticate();
    const res = await getJson(`${base}/GetDateServices.asmx/GetDate?${q({ ...params, mds })}`);
    const code = res.json?.errorCode;
    if ((res.status === 403 || code === 403 || code === '403') && retry) {
      mds = null; await self.authenticate();
      return call(params, false);
    }
    return res;
  }

  const self = {
    async authenticate() {
      const url = `${base}/GetDateServices.asmx/loginSystem?` + q({
        LoginName: account, LoginPassword: password, LoginType: loginType,
        language: 'en', ISMD5: 0, timeZone, apply: 'APP', loginUrl: '',
      });
      const res = await getJson(url);
      if (!res.json?.mds) throw new Error(`18gps login failed: ${res.text.slice(0, 160)}`);
      mds = res.json.mds; unitId = res.json.id;
      return mds;
    },

    // Devices are spread across the root unit + subordinate units (GetCustomTreeById);
    // walk the whole tree so every sub-account's bikes are seen.
    async _loadUnitIds() {
      if (unitIds) return unitIds;
      if (!mds) await self.authenticate();
      const ids = [unitId];
      const seen = new Set([unitId]);
      const walk = async (id) => {
        const res = await call({ method: 'GetCustomTreeById', id });
        for (const n of (res.json?.data || [])) {
          if (n.id && !seen.has(n.id)) {
            seen.add(n.id); ids.push(n.id);
            if (n.isParent === 1 || n.isParent === '1') await walk(n.id);
          }
        }
      };
      try { await walk(unitId); } catch { /* fall back to root unit */ }
      unitIds = ids;
      return ids;
    },

    // Batch read across all units → Map<imei, raw record>, cached briefly so one
    // refresh cycle = one read. Positions live in the same record (weidu/jingdu).
    async _loadBatch(force = false) {
      if (batch && !force && Date.now() - batchAt < BATCH_MS) return batch;
      if (!mds) await self.authenticate();
      const ids = await this._loadUnitIds();
      const map = new Map();
      const ingest = (res) => {
        const block = res?.json?.data?.[0];
        if (!block?.key || !Array.isArray(block.records)) return;
        const keys = Object.entries(block.key);
        for (const rec of block.records) {
          const o = {}; for (const [n, i] of keys) o[n] = rec[i];
          const imei = String(o.sim_id || '').trim();
          if (imei && !map.has(imei)) map.set(imei, o);
        }
      };
      // Fetch each unit; a unit that fails (timeout/transient error) or yields no
      // block is retried, so a flaky call doesn't silently drop a whole sub-account's
      // bikes ("not all bikes appear"). Up to 3 passes over the still-failing units.
      const CONC = 8;
      const fetchUnit = async (id) => {
        const res = await call({ method: 'getDeviceListByCustomId', id, mapType });
        if (!res?.json?.data?.[0]?.key) throw new Error('no device block');
        return res;
      };
      let pending = ids.slice();
      for (let pass = 0; pass < 3 && pending.length; pass++) {
        const failed = [];
        for (let i = 0; i < pending.length; i += CONC) {
          const slice = pending.slice(i, i + CONC);
          const results = await Promise.all(
            slice.map((id) => fetchUnit(id).then((r) => [id, r]).catch(() => [id, null])),
          );
          results.forEach(([id, r]) => { if (r) ingest(r); else failed.push(id); });
        }
        pending = failed;
      }
      batch = map; batchAt = Date.now();
      return map;
    },

    async listDevices() {
      const map = await this._loadBatch();
      return [...map.values()].map((o) => ({
        imei: String(o.sim_id || '').trim(),
        name: cleanPlate(o.plateNumber || o.user_name),
        raw: o,
      }));
    },

    async liveLocations() {
      const map = await this._loadBatch();
      return [...map.values()]
        .map((o) => ({ imei: String(o.sim_id || '').trim(), lat: Number(o.weidu), lng: Number(o.jingdu) }))
        .filter((o) => o.imei && Number.isFinite(o.lat) && Number.isFinite(o.lng) && (o.lat !== 0 || o.lng !== 0));
    },

    async location(imei) {
      const map = await this._loadBatch();
      const o = map.get(String(imei));
      if (!o) return { imei: String(imei), lat: null, lng: null, address: '', gpsTime: null };
      return {
        imei: String(imei),
        lat: Number(o.weidu),
        lng: Number(o.jingdu),
        address: '',
        gpsTime: Number(o.datetime) ? Math.floor(Number(o.datetime) / 1000) : null,
      };
    },

    async status(imei) {
      const map = await this._loadBatch();
      const o = map.get(String(imei));
      if (!o) return { imei: String(imei), online: false, accOn: null, speedKmh: null, ageSec: null, gpsSec: null };
      // 18gps timestamps are epoch MS; use the platform's own server_time as "now"
      // to stay immune to local clock skew.
      const serverMs = Number(o.server_time);
      const heartMs = Number(o.heart_time);
      const fixMs = Number(o.datetime);
      const speedKmh = Number(o.su);
      const gpsSec = Number.isFinite(fixMs) ? Math.floor(fixMs / 1000) : null;
      return {
        imei: String(imei),
        online: Number.isFinite(serverMs) && Number.isFinite(heartMs)
          ? serverMs - heartMs < config.offlineAfterMin * 60_000 : false,
        accOn: accFromStatus(o.status),
        speedKmh: Number.isFinite(speedKmh) ? speedKmh : null,
        ageSec: Number.isFinite(serverMs) && Number.isFinite(fixMs) ? Math.max(0, Math.round((serverMs - fixMs) / 1000)) : null,
        gpsSec,
      };
    },

    // Track playback for 18gps is not wired yet (endpoint unconfirmed), so route
    // replay / day-report history is unavailable for 18gps-only officers. Returns
    // an empty track rather than throwing, so the rest of the report still renders.
    async history() {
      return [];
    },
  };

  return self;
}
