// DD.MM.YYYY HH:mm in the business timezone (Asia/Jerusalem) — the server runs
// in UTC, so every displayed timestamp goes through here. Pure Intl; safe in
// server and client components alike. `sep` '/' gives DD/MM/YYYY HH:mm.
const formatter = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// A `timestamptz::text` column ('2026-10-04 19:13:24.220808+00') is outside the
// date format ECMAScript guarantees — V8 reads it, other engines need not — so
// it is rewritten to ISO (T, milliseconds, ±HH:MM) before parsing.
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d*([+-]\d{2})(?::?(\d{2}))?$/;

function toDate(input: Date | string): Date {
  if (typeof input !== 'string') return input;
  const m = PG_TIMESTAMP.exec(input);
  return new Date(m ? `${m[1]}T${m[2]}${m[3] ?? ''}${m[4]}:${m[5] ?? '00'}` : input);
}

export function formatStamp(input: Date | string | null | undefined, sep: '.' | '/' = '.'): string {
  if (!input) return '';
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return '';
  // Force DD.MM.YYYY HH:mm regardless of the locale's separator quirks.
  const parts = formatter.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}${sep}${get('month')}${sep}${get('year')} ${get('hour')}:${get('minute')}`;
}
