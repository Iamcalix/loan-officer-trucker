// Turn a raw GPS track into meaningful events:
//   - stops (the rider parked/stood somewhere long enough to count)
//   - visits (a stop that lands on a known customer → how long they were together)
//   - office time (stops at the office)
//   - unexplained stops (stopped somewhere that is NOT a customer or the office —
//     "stopped without notice")
//
// A stop is a run of consecutive fixes that stay within stopRadiusM of the run's
// anchor for at least stopMinMinutes. Each stop is classified by its centroid
// against the known places (office + customers).

import { config } from './config.js';
import { classify, haversineM } from './places.js';

function centroid(seg) {
  const lat = seg.reduce((s, p) => s + p.lat, 0) / seg.length;
  const lng = seg.reduce((s, p) => s + p.lng, 0) / seg.length;
  return { lat, lng };
}

export function detectStops(points) {
  const { stopRadiusM, stopMinMinutes } = config.proximity;
  const minSec = stopMinMinutes * 60;
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.gpsSec);
  const stops = [];
  let i = 0;
  while (i < pts.length) {
    const anchor = pts[i];
    let j = i;
    while (j + 1 < pts.length && haversineM(anchor, pts[j + 1]) <= stopRadiusM) j++;
    const durationSec = pts[j].gpsSec - pts[i].gpsSec;
    if (j > i && durationSec >= minSec) {
      const seg = pts.slice(i, j + 1);
      const c = centroid(seg);
      stops.push({
        lat: c.lat, lng: c.lng,
        start: pts[i].gpsSec, end: pts[j].gpsSec,
        durationSec, minutes: Math.round(durationSec / 60), fixes: seg.length,
        place: classify(c), // {type,name,...} or null
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  return stops;
}

// Full analysis for one officer's track.
export function analyzeTrack(points) {
  const stops = detectStops(points);
  const visitsByCustomer = new Map();
  let officeMinutes = 0;
  const unexplained = [];

  for (const s of stops) {
    if (s.place?.type === 'customer') {
      const key = s.place.id || s.place.name;
      const v = visitsByCustomer.get(key) || { id: s.place.id, name: s.place.name, phone: s.place.phone || null, minutes: 0, stops: [] };
      v.minutes += s.minutes;
      v.stops.push({ start: s.start, end: s.end, minutes: s.minutes, lat: s.lat, lng: s.lng });
      visitsByCustomer.set(key, v);
    } else if (s.place?.type === 'office') {
      officeMinutes += s.minutes;
    } else {
      unexplained.push({ lat: s.lat, lng: s.lng, start: s.start, end: s.end, minutes: s.minutes });
    }
  }

  return {
    stops,
    visits: [...visitsByCustomer.values()].sort((a, b) => b.minutes - a.minutes),
    officeMinutes,
    unexplained: unexplained.sort((a, b) => b.minutes - a.minutes),
  };
}
