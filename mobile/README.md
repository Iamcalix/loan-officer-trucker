# Elegansky Field Check-in (Android)

A tiny native Android app for field officers. Pick your name, tap a customer from
today's follow-list, snap a photo of the plate — the phone attaches GPS + date/time and
uploads it. It counts as a **verified visit** in the day report ("Visited (photo)"),
filling the gaps where the bike's GPS can't confirm the visit. Works offline: check-ins
queue and upload when signal returns.

Backend: talks to `https://tracker.eleganskyfinance.com` (`/api/app/officers`,
`/api/app/followlist`, `/api/checkin`). Built with Capacitor (native camera via the
system camera, native GPS via `@capacitor/geolocation`).

## Getting the APK (no Android tooling needed locally)
The APK is built in the cloud by GitHub Actions:

1. GitHub repo → **Actions** tab → **Build Android APK** → **Run workflow** (or it runs
   automatically on any push under `mobile/`).
2. When the run finishes, open it → **Artifacts** → download **elegansky-checkin-apk**.
3. Unzip → `app-debug.apk`. Send it to each officer's phone (WhatsApp/Drive/USB).
4. On the phone: open the APK, allow "install from unknown sources", install.
5. First open: grant **Location** and **Camera** permissions, pick your name — done.

## Config
- API base is `https://tracker.eleganskyfinance.com`. To point elsewhere during testing,
  set `localStorage.apiBase` in the webview.
- Optional `APP_TOKEN` on the server → set the same in the app's request header to lock
  the endpoint down (off by default).

## Local dev
`www/index.html` is the whole app and runs in a desktop browser too (uses the browser
camera/GPS fallbacks) — handy for quick UI testing before building the APK.
