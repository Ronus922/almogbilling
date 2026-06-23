import type { IssueLocationType, IssuePriority, IssueStatus } from '@/lib/types/issues';

export const ISSUE_STATUSES: { value: IssueStatus; label: string; tone: string }[] = [
  { value: 'open', label: 'פתוחה', tone: 'rose' },
  { value: 'in_progress', label: 'בטיפול', tone: 'blue' },
  { value: 'resolved', label: 'טופלה', tone: 'emerald' },
  { value: 'closed', label: 'סגורה', tone: 'slate' },
];

// Active vs completed split for the "פעילות" / "הושלמו" tabs (filter only — no
// new status). Completed = terminal statuses (resolved / closed).
export const COMPLETED_ISSUE_STATUSES: IssueStatus[] = ['resolved', 'closed'];
export const ACTIVE_ISSUE_STATUSES: IssueStatus[] = ['open', 'in_progress'];
export function isCompletedIssueStatus(s: IssueStatus): boolean {
  return COMPLETED_ISSUE_STATUSES.includes(s);
}

// Priority is the kanban's primary axis: exactly three levels (no low/medium).
// Select order = רגילה → גבוהה → דחוף (default רגילה).
export const ISSUE_PRIORITIES: { value: IssuePriority; label: string; tone: string }[] = [
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
  normal: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-rose-100 text-rose-700',
};

// Kanban column accent dot — mirrors tasks STATUS_DOT, keyed to the badge tones.
export const ISSUE_STATUS_DOT: Record<IssueStatus, string> = {
  open: 'bg-rose-500',
  in_progress: 'bg-blue-500',
  resolved: 'bg-emerald-500',
  closed: 'bg-slate-400',
};

// ── Kanban board axis (3 priority lanes + terminal "done" lane) ──────────────
// The board groups active issues by priority into three lanes, plus a fourth
// "בוצע" drop-lane that resolves the issue (moving it to the completed tab).
// RTL order right→left: דחוף · גבוהה · רגילה · בוצע.
export const ISSUE_PRIORITY_DOT: Record<IssuePriority, string> = {
  urgent: 'bg-rose-500',
  high: 'bg-amber-500',
  normal: 'bg-blue-500',
};

export type IssueKanbanColumn =
  | { kind: 'priority'; key: IssuePriority; label: string; dot: string }
  | { kind: 'done'; key: 'done'; label: string; dot: string; status: IssueStatus };

export const ISSUE_KANBAN_COLUMNS: IssueKanbanColumn[] = [
  { kind: 'priority', key: 'urgent', label: PRIORITY_LABELS.urgent, dot: ISSUE_PRIORITY_DOT.urgent },
  { kind: 'priority', key: 'high', label: PRIORITY_LABELS.high, dot: ISSUE_PRIORITY_DOT.high },
  { kind: 'priority', key: 'normal', label: PRIORITY_LABELS.normal, dot: ISSUE_PRIORITY_DOT.normal },
  { kind: 'done', key: 'done', label: 'בוצע', dot: 'bg-emerald-500', status: 'closed' },
];

// ── Image upload validation (server-enforced; mirrored in the client) ────────
export const ISSUE_ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
export const ISSUE_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const ISSUE_MAX_IMAGES = 6;
