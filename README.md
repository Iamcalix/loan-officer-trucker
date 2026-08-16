# Field Officer Tracker

Live GPS map + route replay for field officers, backed by the **Wanway / IoP
Open API** (`open.iopgps.com`) — the same tracker platform smart-collector uses.
Read-only: it never sends cut/restore relay commands.

## What it does
- **Live map** — each field officer's current position, auto-refreshing every 15s,
  colour-coded: 🔵 at office · 🟢 with a customer · ⚪ moving · 🟠 stopped · 🔴 offline.
- **Route replay** — click an officer to load their track for the last N hours,
  scrub or play back the route, with distance, speed, and ACC state per point.
- **Visit verification** — automatically detects every stop (≥5 min stationary)
  and classifies it: which **customer** the officer met and for **how long**,
  time **at the office**, and **unexplained stops** (parked somewhere that is
  neither a customer nor the office — "stopped without notice").

## How "met the customer" is decided
Each customer already has their **own tracked bike**. This app treats every
non-officer tracker as a customer at its current bike position, so an officer is
"with" a customer when their tracker is within `CUSTOMER_RADIUS_M` of that
customer's bike. No addresses to maintain — it stays current automatically.
Field officers are identified by the roster in `data/officers.json`; everything
else is a customer bike. (History matching uses the bike's current position as
the anchor, since customer bikes are normally parked at the customer.)

## Run locally
```bash
cd officer-tracker
cp .env.example .env      # fill WANWAY_APPID + WANWAY_API_KEY (same as smart-collector)
npm start                 # no dependencies to install — Node 18+ only
# open http://localhost:3000
```

## Deploy (Render)
Push to a repo, create a Web Service from `render.yaml`, and set `WANWAY_APPID`
and `WANWAY_API_KEY` in the dashboard. Start command: `node src/server.js`.

## Naming officers
By default each pin/label uses the tracker's device name. To show real names,
create `data/officers.json` (see `data/officers.example.json`) mapping IMEI →
`{ name, phone, area }`. It hot-reloads on change.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/officers` | live snapshot `[{imei,name,area,lat,lng}]` |
| GET | `/api/officers/:imei/history?hours=8` | route points + current status |
| GET | `/api/officers/status?imei=` | one officer's online/ACC/speed/age |
| GET | `/api/health` | liveness |

## How it maps to the trackers
- Auth: `POST /api/auth { appid, time, signature: md5(md5(secret)+time) }` → 2h token.
- Live positions: `GET /api/device/locations/search-by-organization?isTakeSub=1`.
- History: `GET /api/device/track/history?imei&startTime&endTime`.
- Status: `GET /api/device/status?imei`; names: `GET /api/device` (paged).

See `src/gps.js` — adapted from smart-collector's `src/gps/wanwayClient.js`.
