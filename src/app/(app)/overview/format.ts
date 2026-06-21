// Display formatting for the overview widgets. All time math is anchored to
// Asia/Jerusalem (the business tz) so "today"/"HH:MM" never drift by the UTC
// offset. Pure Intl/Date — safe in the node server runtime.
import { todayInJerusalem, addDaysToIsoDate } from '@/lib/dates';

const TZ = 'Asia/Jerusalem';

const ILS = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
});

/** Whole-shekel currency, e.g. ‎₪147,200. */
export function ils(n: number): string {
  return ILS.format(n);
}

/** Rate 0..1 → integer percent, e.g. 0.73 → "73%". */
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** 'YYYY-MM-DD' (Jerusalem local day) for an ISO timestamp. */
export function jslDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

/** 'HH:MM' (24h, Jerusalem) for an ISO timestamp. */
export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('he-IL', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** A 'YYYY-MM-DD' day → היום / מחר / אתמול, else "DD.MM". */
export function relativeDay(isoDate: string): string {
  const today = todayInJerusalem();
  if (isoDate === today) return 'היום';
  if (isoDate === addDaysToIsoDate(today, 1)) return 'מחר';
  if (isoDate === addDaysToIsoDate(today, -1)) return 'אתמול';
  const [, m, d] = isoDate.split('-');
  return `${d}.${m}`;
}

/** Conversation/message timestamp → "HH:MM" when today, else a relative day. */
export function shortStamp(iso: string): string {
  const day = jslDate(iso);
  return day === todayInJerusalem() ? hhmm(iso) : relativeDay(day);
}

/** Two-letter initials for an avatar fallback (first letters of first two words). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? '') + (parts[1][0] ?? '');
}

export const MONTHS_HE = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

/** Hebrew month + year for the calendar header, e.g. "יוני 2026". */
export function monthYearLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_HE[m - 1]} ${y}`;
}
