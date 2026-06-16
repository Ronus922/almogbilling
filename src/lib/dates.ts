// Business-timezone date helpers. The CRM operates in Asia/Jerusalem, so any
// "per-day" bucket (dedupe windows, due-soon scans) must be computed in that
// zone — NOT UTC. A UTC day boundary (toISOString().slice(0,10)) rolls over at
// 02:00/03:00 Israel time, which would split evening events onto the "next" day
// and break one-per-day dedupe. Pure Intl/Date math → safe in any runtime.

/**
 * Today's date as 'YYYY-MM-DD' in Asia/Jerusalem. `en-CA` formats as ISO
 * (YYYY-MM-DD), so this is a stable, locale-independent day key.
 */
export function todayInJerusalem(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Add `days` to a 'YYYY-MM-DD' string and return a 'YYYY-MM-DD' string. Anchored
 * at UTC-noon so DST transitions never shift the calendar day.
 */
export function addDaysToIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
