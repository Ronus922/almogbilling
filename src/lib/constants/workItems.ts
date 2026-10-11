// Unified תקלות/משימות module (11/10/2026) — color language, new section in
// DESIGN.md ("שפת צבעים — תקלות ומשימות"). Card/row color belongs to PRIORITY
// only; status is a chip, never a card color.
import type { WorkItemStatusV2 } from '@/lib/types/workItems';

export const WORK_PRIORITY_CARD: Record<'normal' | 'high' | 'urgent', string> = {
  normal: '',
  high: 'border-amber-300 bg-amber-50',
  urgent: 'border-rose-300 bg-rose-50',
};

export const WORK_PRIORITY_TAG: Record<'normal' | 'high' | 'urgent', string | null> = {
  normal: null,
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-rose-100 text-rose-700',
};

export const WORK_PRIORITY_LABEL: Record<'normal' | 'high' | 'urgent', string> = {
  normal: 'רגילה',
  high: 'גבוהה',
  urgent: 'דחופה',
};

export const WORK_STATUS_DOT: Record<WorkItemStatusV2, string> = {
  open: 'bg-blue-600',
  in_progress: 'bg-amber-600',
  closed: 'bg-emerald-600',
};

export const WORK_STATUS_LABEL: Record<WorkItemStatusV2, string> = {
  open: 'פתוח',
  in_progress: 'בטיפול',
  closed: 'סגור',
};

export const WORK_NEW_TAG = 'bg-blue-600 text-white';
export const WORK_BLOCKED_TAG = 'bg-red-100 text-red-700';
export const WORK_OVERDUE_TEXT = 'text-red-700';
export const WORK_RESIDENT_TAG = 'bg-teal-100 text-teal-700';
export const WORK_KIND_TAG: Record<'issue' | 'task', string> = {
  issue: 'bg-sky-50 text-sky-700',
  task: 'bg-violet-50 text-violet-700',
};
export const WORK_KIND_LABEL: Record<'issue' | 'task', string> = {
  issue: 'תקלה',
  task: 'משימה',
};
export const WORK_AVATAR = 'bg-blue-100 text-blue-700';
