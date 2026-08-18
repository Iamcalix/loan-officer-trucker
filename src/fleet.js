// Combined read-only fleet client. ELEGANSKY's trackers are split across TWO GPS
// platforms — Wanway/IoP (~1,600) and 18gps (~7,000) — and a bike may live on
// either (or both). This wraps both backends behind the SAME interface the server
// already consumes (listDevices / liveLocations / location / status / history), so
// EVERY bike shows up regardless of which platform hosts its tracker.
//
// Per-IMEI calls (status/location/history) are routed to the platform that owns
// that IMEI. The owner map is populated from listDevices()/liveLocations(), which
// the server always calls before any per-device lookup.

import { config, platformsEnabled } from './config.js';
import { createGpsClient } from './gps.js';
import { create18gpsClient } from './gps18.js';

export function createFleetClient() {
  const backends = [];
  if (platformsEnabled.wanway) backends.push({ name: 'wanway', client: createGpsClient() });
  if (platformsEnabled.gps18) backends.push({ name: '18gps', client: create18gpsClient() });
  if (!backends.length) throw new Error('No GPS platform configured (Wanway and/or 18gps).');

  // imei -> backend client, learned as we read rosters/positions.
  const owner = new Map();
  const remember = (imei, client) => { if (imei && !owner.has(imei)) owner.set(imei, client); };

  // Run a read across all backends; a failing backend must not sink the others
  // (e.g. one platform down should still show the other's bikes).
  async function fanOut(fn) {
    const results = await Promise.allSettled(backends.map((b) => fn(b)));
    return results.flatMap((r, i) =>
      r.status === 'fulfilled' ? [{ name: backends[i].name, client: backends[i].client, value: r.value }] : []);
  }

  function clientFor(imei) {
    return owner.get(String(imei)) || backends[0].client;
  }

  return {
    async authenticate() {
      await Promise.allSettled(backends.map((b) => b.client.authenticate()));
    },

    // Merge device rosters. IMEIs are globally unique across platforms, so a plate
    // that has a tracker on BOTH platforms appears once per tracker (distinct IMEIs).
    async listDevices() {
      const parts = await fanOut((b) => b.client.listDevices());
      const byImei = new Map();
      for (const { client, value } of parts) {
        for (const d of value || []) {
          remember(d.imei, client);
          if (!byImei.has(d.imei)) byImei.set(d.imei, d);
        }
      }
      return [...byImei.values()];
    },

    async liveLocations() {
      const parts = await fanOut((b) => b.client.liveLocations());
      const byImei = new Map();
      for (const { client, value } of parts) {
        for (const l of value || []) {
          remember(l.imei, client);
          if (!byImei.has(l.imei)) byImei.set(l.imei, l);
        }
      }
      return [...byImei.values()];
    },

    location(imei) { return clientFor(imei).location(imei); },
    status(imei) { return clientFor(imei).status(imei); },
    history(imei, startSec, endSec) { return clientFor(imei).history(imei, startSec, endSec); },
  };
}
