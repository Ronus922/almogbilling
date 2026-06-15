import type { UserReminderStatus } from '@/lib/types/userReminders';

// Status display for the user-facing Reminders module. `dot` is a Tailwind bg
// utility for the small status indicator on each card; `text` for the label.
export const REMINDER_STATUSES: {
  value: UserReminderStatus;
  label: string;
  dot: string;
  text: string;
}[] = [
  { value: 'pending', label: 'ממתין', dot: 'bg-amber-500', text: 'text-amber-600' },
  { value: 'done', label: 'הושלם', dot: 'bg-emerald-500', text: 'text-emerald-600' },
  { value: 'dismissed', label: 'נדחה', dot: 'bg-slate-400', text: 'text-slate-500' },
];

const STATUS_MAP = new Map(REMINDER_STATUSES.map((s) => [s.value, s]));

export function reminderStatusLabel(s: UserReminderStatus): string {
  return STATUS_MAP.get(s)?.label ?? s;
}
export function reminderStatusDot(s: UserReminderStatus): string {
  return STATUS_MAP.get(s)?.dot ?? 'bg-slate-400';
}
export function reminderStatusText(s: UserReminderStatus): string {
  return STATUS_MAP.get(s)?.text ?? 'text-slate-500';
}

// Default fill for the card side-stripe / category dot when a reminder has no
// category (border-line in hex — keeps it a faint neutral). Real categories use
// their own user-chosen `color` (data, not a token — DESIGN.md §2).
export const UNCATEGORIZED_COLOR = '#e8eaf2';

// Suggested swatches for the category color picker — vivid brand-aligned hues
// (the stripe/dot reads better saturated than the pale status palette). The
// picker also accepts any free-form hex, so this is guidance, not a constraint.
export const REMINDER_CATEGORY_COLORS: { hex: string; label: string }[] = [
  { hex: '#3d5afe', label: 'brand' },
  { hex: '#6366f1', label: 'indigo' },
  { hex: '#8b5cf6', label: 'violet' },
  { hex: '#ec4899', label: 'pink' },
  { hex: '#ef4444', label: 'red' },
  { hex: '#f59e0b', label: 'amber' },
  { hex: '#10b981', label: 'emerald' },
  { hex: '#14b8a6', label: 'teal' },
  { hex: '#0ea5e9', label: 'sky' },
  { hex: '#64748b', label: 'slate' },
  { hex: '#84cc16', label: 'lime' },
  { hex: '#f97316', label: 'orange' },
];
