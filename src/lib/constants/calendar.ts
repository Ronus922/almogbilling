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

const COLOR_MAP = new Map(COLOR_OPTIONS.map((c) => [c.key, c]));

export function eventBlockClasses(colorKey: string): string {
  return (COLOR_MAP.get(colorKey as CalendarColorKey) ?? COLOR_OPTIONS[0]).block;
}
export function eventDotClass(colorKey: string): string {
  return (COLOR_MAP.get(colorKey as CalendarColorKey) ?? COLOR_OPTIONS[0]).dot;
}

export function itemKindLabel(k: CalendarItemKind): string {
  return ITEM_KINDS.find((x) => x.value === k)?.label ?? k;
}
export function eventStatusLabel(s: CalendarEventStatus): string {
  return EVENT_STATUSES.find((x) => x.value === s)?.label ?? s;
}
export function recurrenceTypeLabel(t: RecurrenceType): string {
  return RECURRENCE_TYPES.find((x) => x.value === t)?.label ?? t;
}
