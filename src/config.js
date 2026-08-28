// Configuration for the officer-tracker service. All secrets come from the
// environment so nothing sensitive lives in the repo. The Wanway credentials
// intentionally reuse the SAME env var names as smart-collector, so the existing
// ELEGANSKY account creds carry straight over (WANWAY_APPID + WANWAY_API_KEY).

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: num(process.env.PORT, 3000),

  // Wanway / IoP Open API (open.iopgps.com). appid is the account NAME; the
  // secret key (WANWAY_API_KEY) signs the auth handshake.
  wanway: {
    base: (process.env.WANWAY_API_BASE || 'https://open.iopgps.com').replace(/\/+$/, ''),
    appid: process.env.WANWAY_APPID || '',
    secret: process.env.WANWAY_SECRET || process.env.WANWAY_API_KEY || '',
    // Bulk org-location read: include devices under sub-accounts too.
    isTakeSub: bool(process.env.WANWAY_TAKE_SUB, true) ? 1 : 0,
    accountId: process.env.WANWAY_ACCOUNT_ID || '', // '' = the token's own root account
  },

  // 18gps Open API (api.18gps.net). The MAJORITY of the fleet lives here, not on
  // Wanway — a bike like MC563EUD is only visible via this platform. Same creds as
  // smart-collector (GPS_LOGIN_USER / GPS_LOGIN_PASS). Read-only: positions only,
  // no cut/restore. Disabled automatically if the login is unset.
  gps18: {
    base: (process.env.GPS_API_BASE || 'https://api.18gps.net').replace(/\/+$/, ''),
    account: process.env.GPS_LOGIN_USER || process.env.GPS_ACCOUNT || '',
    password: process.env.GPS_LOGIN_PASS || process.env.GPS_PASSWORD || '',
    loginType: process.env.GPS_LOGIN_TYPE || 'ENTERPRISE',
    timeZone: process.env.GPS_TIMEZONE || '+03',
    mapType: process.env.GPS_MAP_TYPE || 'google',
  },

  // Supabase — durable storage for the officer roster (Render's free disk is
  // ephemeral and wipes officers.json on restart). Uses the SECRET service key,
  // server-side only. Unset → falls back to the local data/officers.json file.
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    key: process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  },

  httpTimeoutMs: num(process.env.HTTP_TIMEOUT_MS, 15000),
  // How stale a signal may be before an officer is shown "offline" (minutes).
  offlineAfterMin: num(process.env.OFFLINE_AFTER_MIN, 25),
  // Server-side cache TTL for the bulk live snapshot (ms). Keeps us well under
  // the platform's auth/read rate limits even with many map viewers.
  liveCacheMs: num(process.env.LIVE_CACHE_MS, 15000),

  // The office. When an officer's fix is within radius of this point they are
  // shown "At office". Leave lat/lng unset to disable.
  office: {
    name: process.env.OFFICE_NAME || 'Office',
    lat: process.env.OFFICE_LAT !== undefined ? Number(process.env.OFFICE_LAT) : null,
    lng: process.env.OFFICE_LNG !== undefined ? Number(process.env.OFFICE_LNG) : null,
    radiusM: num(process.env.OFFICE_RADIUS_M, 120),
  },

  // Where nightly report files are written (served at /reports for download).
  // On Render this should point at a persistent disk mount.
  reportsDir: process.env.REPORTS_DIR || './reports',
  // Nightly report generation, in East Africa Time.
  report: {
    enabled: bool(process.env.REPORT_ENABLED, true),
    hourEat: num(process.env.REPORT_HOUR_EAT, 21), // generate the day's report at ~21:00 EAT
    minuteEat: num(process.env.REPORT_MINUTE_EAT, 0),
  },

  // Visit / stop-detection tuning.
  proximity: {
    // How close (metres) an officer must be to a customer to count as "with" them.
    customerRadiusM: num(process.env.CUSTOMER_RADIUS_M, 150),
    // UNASSIGNED (off-list) meetings are sensitive — flagging one wrongly is unfair.
    // Require MUCH tighter proximity and a longer stay so only a genuine, sat-down
    // meeting is reported (an assigned customer stays lenient).
    unassignedRadiusM: num(process.env.UNASSIGNED_RADIUS_M, 60),
    unassignedMinMinutes: num(process.env.UNASSIGNED_MIN_MINUTES, 10),
    // A "stop" is a run of fixes that stays inside this radius (metres)…
    stopRadiusM: num(process.env.STOP_RADIUS_M, 80),
    // …for at least this long (minutes). Shorter clusters are treated as passing through.
    stopMinMinutes: num(process.env.STOP_MIN_MINUTES, 5),
    // Fixes at/below this speed (km/h) are considered stationary.
    stopSpeedKmh: num(process.env.STOP_SPEED_KMH, 4),
    // "Stopped to talk": a meeting only counts when BOTH the officer's and the
    // customer's bike are essentially STOPPED (≤ this km/h — trackers report 0 when
    // parked, so a small value tolerates GPS jitter while excluding creeping/passing).
    meetSpeedKmh: num(process.env.MEET_SPEED_KMH, 2),
    // A live fix at/below this speed marks the officer "stopped" (vs "moving").
    movingSpeedKmh: num(process.env.MOVING_SPEED_KMH, 6),
  },
};

export function assertConfigured() {
  const wanway = config.wanway.appid && config.wanway.secret;
  const g18 = config.gps18.account && config.gps18.password;
  if (!wanway && !g18) {
    throw new Error(
      'No GPS platform configured. Set WANWAY_APPID + WANWAY_API_KEY and/or GPS_LOGIN_USER + GPS_LOGIN_PASS (same values as smart-collector).',
    );
  }
}

export const platformsEnabled = {
  get wanway() { return Boolean(config.wanway.appid && config.wanway.secret); },
  get gps18() { return Boolean(config.gps18.account && config.gps18.password); },
};
