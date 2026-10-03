import type { IssuePriority, IssueStatus } from '@/lib/types/issues';

export const ISSUE_STATUSES: { value: IssueStatus; label: string; tone: string }[] = [
  { value: 'open', label: 'פתוחה', tone: 'rose' },
  { value: 'in_progress', label: 'בטיפול', tone: 'blue' },
  { value: 'resolved', label: 'טופלה', tone: 'emerald' },
  { value: 'closed', label: 'סגורה', tone: 'slate' },
];

// Active vs completed split for the "פעילות" / "הושלמו" tabs (filter only — no
// new status). Completed = terminal statuses (resolved / closed).
const COMPLETED_ISSUE_STATUSES: IssueStatus[] = ['resolved', 'closed'];
export const ACTIVE_ISSUE_STATUSES: IssueStatus[] = ['open', 'in_progress'];
export function isCompletedIssueStatus(s: IssueStatus): boolean {
  return COMPLETED_ISSUE_STATUSES.includes(s);
}

// Priority: exactly three levels (no low/medium) — a tag, a filter and the
// first sort key inside a kanban column. Select order = רגילה → גבוהה → דחוף
// (default רגילה).
export const ISSUE_PRIORITIES: { value: IssuePriority; label: string; tone: string }[] = [
  { value: 'normal', label: 'רגילה', tone: 'blue' },
  { value: 'high', label: 'גבוהה', tone: 'amber' },
  { value: 'urgent', label: 'דחופה', tone: 'rose' },
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

export function issueStatusLabel(s: IssueStatus): string {
  return STATUS_LABELS[s] ?? s;
}
export function issuePriorityLabel(p: IssuePriority): string {
  return PRIORITY_LABELS[p] ?? p;
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

// ── Kanban board ─────────────────────────────────────────────────────────────
// Since 03/10/2026 the board's columns are STAGES OF HANDLING (ממתין לשיוך ·
// לטיפול היום · בטיפול · בוצע), computed in lib/issues/board.ts. Priority is a
// tag, a filter and the first sort key inside a column.

// ── Image upload validation (server-enforced; mirrored in the client) ────────
export const ISSUE_ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
export const ISSUE_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const ISSUE_MAX_IMAGES = 6;

// ── Video upload validation (server-enforced; mirrored in the client) ────────
// Same private bucket / proxy / path guard as images — a separate column and
// separate caps (migration 064). quicktime = the .mov an iPhone records.
export const ISSUE_ALLOWED_VIDEO_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
];
export const ISSUE_MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const ISSUE_MAX_VIDEOS = 3;
