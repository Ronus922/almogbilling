// Shared visual mappings for the overview widgets. Colors map to the DESIGN.md
// §2 tone palette (violet / red / amber / emerald / sky / slate), NOT the raw
// hexes of the mockup. Kept in one place so the calendar legend, task/issue
// rows and dots stay in lockstep.
import type { TaskPriority } from '@/lib/types/tasks';
import type { IssuePriority } from '@/lib/types/issues';
import type { CalKind } from './data';

interface Swatch {
  /** Hex dot color (calendar / list leading dot). */
  dot: string;
  /** Pill classes: soft bg + text. */
  pill: string;
  label: string;
}

/** Task priority → leading dot + priority pill. */
export const TASK_PRIORITY: Record<TaskPriority, Swatch> = {
  urgent: { dot: '#e5484d', pill: 'bg-red-50 text-red-600',       label: 'דחוף' },
  high:   { dot: '#e5484d', pill: 'bg-red-50 text-red-600',       label: 'גבוהה' },
  normal: { dot: '#e08700', pill: 'bg-amber-50 text-amber-700',   label: 'בינונית' },
};

/** Issue priority → severity pill. urgent reads as the loudest ("קריטי"). */
export const ISSUE_PRIORITY: Record<IssuePriority, { pill: string; label: string }> = {
  urgent: { pill: 'bg-red-600 text-white',       label: 'קריטי' },
  high:   { pill: 'bg-red-50 text-red-600',      label: 'גבוה' },
  normal: { pill: 'bg-amber-50 text-amber-700',  label: 'בינוני' },
};

/** Calendar dot color per overlaid item kind. */
export const KIND_DOT: Record<CalKind, string> = {
  task:     '#7c5cfc', // violet
  issue:    '#e5484d', // red
  reminder: '#e08700', // amber
  event:    '#3d5afe', // brand blue
};

export const KIND_LEGEND: { kind: CalKind; label: string }[] = [
  { kind: 'task', label: 'משימה' },
  { kind: 'issue', label: 'תקלה' },
  { kind: 'reminder', label: 'תזכורת' },
  { kind: 'event', label: 'אירוע' },
];
