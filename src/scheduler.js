// Fires the nightly report once per day at REPORT_HOUR_EAT:REPORT_MINUTE_EAT
// (East Africa Time). Runs inside the always-on web service, so no external cron
// is needed. Dedupes by date so a restart after the hour doesn't double-run.

import { config } from './config.js';

export function startReportScheduler(generate) {
  if (!config.report.enabled) {
    console.log('Report scheduler disabled (REPORT_ENABLED=false).');
    return;
  }
  let lastDate = null;
  const tick = async () => {
    const eat = new Date(Date.now() + 3 * 3600_000); // shift to EAT, read UTC parts
    const date = eat.toISOString().slice(0, 10);
    const h = eat.getUTCHours();
    const m = eat.getUTCMinutes();
    const due = h > config.report.hourEat || (h === config.report.hourEat && m >= config.report.minuteEat);
    if (due && lastDate !== date) {
      lastDate = date;
      try {
        const r = await generate(date);
        console.log(`Nightly report saved for ${date}: ${r?.count ?? 0} officer(s).`);
      } catch (e) {
        console.error(`Nightly report for ${date} failed: ${e.message}`);
      }
    }
  };
  setInterval(tick, 60_000);
  tick();
  console.log(`Report scheduler armed for ${String(config.report.hourEat).padStart(2, '0')}:${String(config.report.minuteEat).padStart(2, '0')} EAT daily.`);
}
