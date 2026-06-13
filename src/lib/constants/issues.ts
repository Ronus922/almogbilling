import type { IssueLocationType, IssuePriority, IssueStatus } from '@/lib/types/issues';

export const ISSUE_STATUSES: { value: IssueStatus; label: string; tone: string }[] = [
  { value: 'open', label: 'פתוחה', tone: 'rose' },
  { value: 'in_progress', label: 'בטיפול', tone: 'blue' },
  { value: 'resolved', label: 'טופלה', tone: 'emerald' },
  { value: 'closed', label: 'סגורה', tone: 'slate' },
];

export const ISSUE_PRIORITIES: { value: IssuePriority; label: string; tone: string }[] = [
  { value: 'low', label: 'נמוכה', tone: 'slate' },
  { value: 'normal', label: 'רגילה', tone: 'blue' },
  { value: 'high', label: 'גבוהה', tone: 'amber' },
  { value: 'urgent', label: 'דחופה', tone: 'rose' },
];

export const ISSUE_LOCATION_TYPES: { value: IssueLocationType; label: string }[] = [
  { value: 'general', label: 'כללי' },
  { value: 'apartment', label: 'דירה' },
  { value: 'area', label: 'שטח משותף' },
];

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'פתוחה',
  in_progress: 'בטיפול',
  resolved: 'טופלה',
  closed: 'סגורה',
};
const PRIORITY_LABELS: Record<IssuePriority, string> = {
  low: 'נמוכה',
  normal: 'רגילה',
  high: 'גבוהה',
  urgent: 'דחופה',
};
const LOCATION_LABELS: Record<IssueLocationType, string> = {
  general: 'כללי',
  apartment: 'דירה',
  area: 'שטח משותף',
};

export function issueStatusLabel(s: IssueStatus): string {
  return STATUS_LABELS[s] ?? s;
}
export function issuePriorityLabel(p: IssuePriority): string {
  return PRIORITY_LABELS[p] ?? p;
}
export function issueLocationTypeLabel(t: IssueLocationType): string {
  return LOCATION_LABELS[t] ?? t;
}

/** "מספר דירה" / "תיאור אזור" depending on location_type (UI label hint). */
export function locationTextLabel(t: IssueLocationType): string {
  if (t === 'apartment') return 'מספר דירה';
  if (t === 'area') return 'תיאור האזור';
  return 'פירוט מיקום (אופציונלי)';
}

// Tailwind soft-badge classes (DESIGN.md §10 / §2 tone variants).
export const ISSUE_STATUS_BADGE: Record<IssueStatus, string> = {
  open: 'bg-rose-100 text-rose-700',
  in_progress: 'bg-blue-100 text-blue-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-slate-100 text-slate-600',
};

export const ISSUE_PRIORITY_BADGE: Record<IssuePriority, string> = {
  low: 'bg-slate-100 text-slate-500',
  normal: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-rose-100 text-rose-700',
};

// ── Image upload validation (server-enforced; mirrored in the client) ────────
export const ISSUE_ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
export const ISSUE_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const ISSUE_MAX_IMAGES = 6;
