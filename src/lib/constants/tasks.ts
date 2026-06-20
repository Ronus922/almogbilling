import type { TaskPriority, TaskStatus } from '@/lib/types/tasks';

export const TASK_STATUSES: { value: TaskStatus; label: string; tone: string }[] = [
  { value: 'open', label: 'פתוח', tone: 'slate' },
  { value: 'in_progress', label: 'בתהליך', tone: 'blue' },
  { value: 'done', label: 'הושלם', tone: 'emerald' },
  { value: 'cancelled', label: 'בוטל', tone: 'rose' },
];

// Active vs completed split for the "פעילות" / "הושלמו" tabs (filter only — no
// new status). Completed = terminal statuses (done / cancelled).
export const COMPLETED_TASK_STATUSES: TaskStatus[] = ['done', 'cancelled'];
export const ACTIVE_TASK_STATUSES: TaskStatus[] = ['open', 'in_progress'];
export function isCompletedTaskStatus(s: TaskStatus): boolean {
  return COMPLETED_TASK_STATUSES.includes(s);
}

export const TASK_PRIORITIES: { value: TaskPriority; label: string; tone: string }[] = [
  { value: 'low', label: 'נמוכה', tone: 'slate' },
  { value: 'normal', label: 'רגילה', tone: 'blue' },
  { value: 'high', label: 'גבוהה', tone: 'amber' },
  { value: 'urgent', label: 'דחוף', tone: 'rose' },
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'פתוח',
  in_progress: 'בתהליך',
  done: 'הושלם',
  cancelled: 'בוטל',
};
const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'נמוכה',
  normal: 'רגילה',
  high: 'גבוהה',
  urgent: 'דחוף',
};

export function taskStatusLabel(s: TaskStatus): string {
  return STATUS_LABELS[s] ?? s;
}
export function taskPriorityLabel(p: TaskPriority): string {
  return PRIORITY_LABELS[p] ?? p;
}

// Tailwind soft-badge classes (DESIGN.md §10 / §2 tone variants).
export const STATUS_BADGE: Record<TaskStatus, string> = {
  open: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
};

export const PRIORITY_BADGE: Record<TaskPriority, string> = {
  low: 'bg-slate-100 text-slate-500',
  normal: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-rose-100 text-rose-700',
};

// Kanban column accent (left rail dot/header).
export const STATUS_DOT: Record<TaskStatus, string> = {
  open: 'bg-slate-400',
  in_progress: 'bg-blue-500',
  done: 'bg-emerald-500',
  cancelled: 'bg-rose-500',
};
