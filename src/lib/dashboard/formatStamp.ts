// DD.MM.YYYY HH:mm in the business timezone (Asia/Jerusalem) — the server runs
// in UTC, so every displayed timestamp goes through here. Pure Intl; safe in
// server and client components alike.
const formatter = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatStamp(input: Date | string | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  // Force DD.MM.YYYY HH:mm regardless of the locale's separator quirks.
  const parts = formatter.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}
