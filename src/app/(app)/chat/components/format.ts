// Hebrew display helpers for the internal-chat module.
// The server runs in UTC; all calendar/time output is anchored to Asia/Jerusalem
// so SSR and client hydration render identical text (no React #418 mismatch).
import { todayInJerusalem, addDaysToIsoDate } from '@/lib/dates';

const TZ = 'Asia/Jerusalem';

/** 'YYYY-MM-DD' Jerusalem calendar day for a Date. */
function jslDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Time only — "14:30" (Jerusalem). */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "היום" / "אתמול" / dd/mm/yyyy — the day separator inside a thread.
 *  Day buckets are Jerusalem-anchored → deterministic across server and client. */
export function formatRelativeDay(iso: string): string {
  const d = new Date(iso);
  const day = jslDay(d);
  const today = todayInJerusalem();
  if (day === today) return 'היום';
  if (day === addDaysToIsoDate(today, -1)) return 'אתמול';
  // Long month to match the ref's date chip ("16 ביוני 2026").
  return new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** Relative "now/minutes/hours" for recent, else a short date — the list stamp.
 *  `Date.now()`-relative → render only AFTER mount (useHasMounted); use
 *  formatStableStamp() as the pre-mount value. Day buckets are Jerusalem-anchored. */
export function formatRelativeStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'עכשיו';
  if (diffMin < 60) return `לפני ${diffMin} ד׳`;
  const diffH = Math.floor(diffMin / 60);
  const day = jslDay(d);
  const today = todayInJerusalem();
  if (day === today) return diffH <= 1 ? 'לפני שעה' : `לפני ${diffH} שע׳`;
  if (day === addDaysToIsoDate(today, -1)) return 'אתמול';
  return new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d);
}

/** Deterministic absolute stamp (Jerusalem) — SSR-safe pre-mount placeholder for
 *  formatRelativeStamp(): "HH:MM" when today, else "DD.MM". */
export function formatStableStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (jslDay(d) === todayInJerusalem()) return formatTime(iso);
  return new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d);
}

// Per-user avatar tints — the ref shows each person on a different soft colour.
// Deterministic by name (no DB field needed). Green/emerald deliberately omitted:
// DESIGN.md reserves green for WhatsApp + the "online" status indicator.
const AVATAR_TONES = [
  'bg-violet-100 text-violet-700',
  'bg-orange-100 text-orange-700',
  'bg-rose-100 text-rose-700',
  'bg-sky-100 text-sky-700',
  'bg-amber-100 text-amber-700',
  'bg-indigo-100 text-indigo-700',
  'bg-fuchsia-100 text-fuchsia-700',
  'bg-cyan-100 text-cyan-700',
] as const;

/** Stable soft avatar tone (bg+text classes) derived from a display name. */
export function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Two-letter initials from a display name. */
export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}
