// Hebrew display helpers for the internal-chat module.

/** Time only — "14:30". */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "היום" / "אתמול" / dd/mm/yyyy — the day separator inside a thread. */
export function formatRelativeDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);
  if (diffDays === 0) return 'היום';
  if (diffDays === 1) return 'אתמול';
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Relative "now/minutes/hours" for recent, else a short date — the list stamp. */
export function formatRelativeStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'עכשיו';
  if (diffMin < 60) return `לפני ${diffMin} ד׳`;
  const diffH = Math.floor(diffMin / 60);
  if (d.toDateString() === new Date().toDateString()) {
    return diffH <= 1 ? 'לפני שעה' : `לפני ${diffH} שע׳`;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'אתמול';
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(d);
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
