// Local-time date helpers for the native calendar grid. The grid works in the
// browser's local timezone; event_date is a plain 'YYYY-MM-DD' string compared
// by value (no timezone math), which keeps the all-day model stable.

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for a local Date. */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
/** Sunday-start week containing d (week begins on Sunday in this UI). */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // getDay(): 0=Sun … 6=Sat
  return x;
}

/**
 * 6-week (42-cell) grid covering the month of `d`, Sunday-first. Always 42
 * cells so the grid height never jumps between months.
 */
export function monthGridDays(d: Date): Date[] {
  const first = startOfMonth(d);
  const gridStart = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** The 7 days of the Sunday-start week containing `d`. */
export function weekDays(d: Date): Date[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
