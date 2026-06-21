import type {
  CalendarColorKey,
  CalendarEventStatus,
  CalendarItemKind,
  RecurrenceType,
} from '@/lib/types/calendar';

export const HE_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const HE_DAY_NAMES_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const HE_MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export const ITEM_KINDS: { value: CalendarItemKind; label: string }[] = [
  { value: 'meeting', label: 'פגישה' },
  { value: 'event', label: 'אירוע' },
];

export const EVENT_STATUSES: { value: CalendarEventStatus; label: string }[] = [
  { value: 'scheduled', label: 'מתוכנן' },
  { value: 'completed', label: 'הושלם' },
  { value: 'cancelled', label: 'בוטל' },
];

export const RECURRENCE_TYPES: { value: RecurrenceType; label: string }[] = [
  { value: 'daily', label: 'יומי' },
  { value: 'weekly', label: 'שבועי' },
  { value: 'monthly', label: 'חודשי' },
  { value: 'yearly', label: 'שנתי' },
];

/** Color palette — keys map to DESIGN.md §2 tone variants. */
export const COLOR_OPTIONS: {
  key: CalendarColorKey;
  label: string;
  /** Event block (soft bg + strong text + subtle border). */
  block: string;
  /** Solid dot for the swatch picker. */
  dot: string;
}[] = [
  { key: 'blue', label: 'כחול', block: 'bg-blue-100 text-blue-800 border-blue-300', dot: 'bg-blue-500' },
  { key: 'emerald', label: 'ירוק', block: 'bg-emerald-100 text-emerald-800 border-emerald-300', dot: 'bg-emerald-500' },
  { key: 'amber', label: 'כתום', block: 'bg-amber-100 text-amber-800 border-amber-300', dot: 'bg-amber-500' },
  { key: 'rose', label: 'אדום', block: 'bg-rose-100 text-rose-800 border-rose-300', dot: 'bg-rose-500' },
  { key: 'violet', label: 'סגול', block: 'bg-violet-100 text-violet-800 border-violet-300', dot: 'bg-violet-500' },
  { key: 'sky', label: 'תכלת', block: 'bg-sky-100 text-sky-800 border-sky-300', dot: 'bg-sky-500' },
  { key: 'slate', label: 'אפור', block: 'bg-slate-100 text-slate-700 border-slate-300', dot: 'bg-slate-500' },
];

// ── Calendar item chips (4 item types) ───────────────────────────────────────
// The calendar overlays four item types; they share ONE chip structure (a soft
// background + a leading dot in month, a 3px start-edge accent in week/day) and
// differ ONLY by color (+ icon, set in the view). Hexes are locked per spec:
//   event    → the user-chosen color_key tone (blue/emerald/amber/rose/…)
//   task     → green  #dcfce7 / #22c55e / #15803d  (green-100/500/700)
//   issue    → red    #fee2e2 / #ef4444 / #b91c1c  (red-100/500/700)
//   reminder → slate  #f1f5f9 / #94a3b8 / #475569  (slate-100/400/600)
export interface ChipTone {
  /** soft chip background */
  bg: string;
  /** chip text color */
  text: string;
  /** solid leading dot (month) — a bg-* class */
  dot: string;
  /** start-edge accent (week/day border-inline-end) — a border-* class */
  edge: string;
}

const EVENT_CHIP_TONES: Record<CalendarColorKey, ChipTone> = {
  blue: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-600', edge: 'border-blue-600' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-600', edge: 'border-emerald-600' },
  amber: { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-600', edge: 'border-amber-600' },
  rose: { bg: 'bg-rose-100', text: 'text-rose-700', dot: 'bg-rose-600', edge: 'border-rose-600' },
  violet: { bg: 'bg-violet-100', text: 'text-violet-700', dot: 'bg-violet-600', edge: 'border-violet-600' },
  sky: { bg: 'bg-sky-100', text: 'text-sky-700', dot: 'bg-sky-600', edge: 'border-sky-600' },
  slate: { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-600', edge: 'border-slate-600' },
};

const OVERLAY_CHIP_TONES: Record<'task' | 'issue' | 'reminder', ChipTone> = {
  task: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500', edge: 'border-green-500' },
  issue: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', edge: 'border-red-500' },
  reminder: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400', edge: 'border-slate-400' },
};

/** Chip tone for any calendar item, by kind (+ color_key for events). */
export function chipTone(kind: string, colorKey?: string): ChipTone {
  if (kind === 'event') {
    return EVENT_CHIP_TONES[(colorKey as CalendarColorKey)] ?? EVENT_CHIP_TONES.blue;
  }
  return OVERLAY_CHIP_TONES[kind as 'task' | 'issue' | 'reminder'] ?? OVERLAY_CHIP_TONES.reminder;
}

/** Hebrew label per item kind (legend + a11y titles). */
export const ITEM_KIND_LABEL: Record<string, string> = {
  event: 'אירוע',
  task: 'משימה',
  issue: 'תקלה',
  reminder: 'תזכורת',
};

export function itemKindLabel(k: CalendarItemKind): string {
  return ITEM_KINDS.find((x) => x.value === k)?.label ?? k;
}
export function eventStatusLabel(s: CalendarEventStatus): string {
  return EVENT_STATUSES.find((x) => x.value === s)?.label ?? s;
}
export function recurrenceTypeLabel(t: RecurrenceType): string {
  return RECURRENCE_TYPES.find((x) => x.value === t)?.label ?? t;
}
