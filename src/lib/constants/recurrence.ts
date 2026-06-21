import type {
  RecurrenceFrequency, RecurrenceEndType, RecurrenceRule,
} from '@/lib/recurrence/engine';

// Labels + form state for the task-recurrence UI (RecurrenceSection). Kept in the
// tasks domain (independent of the calendar's own recurrence constants).

export const RECURRENCE_FREQUENCIES: { value: RecurrenceFrequency; label: string }[] = [
  { value: 'daily', label: 'יומי' },
  { value: 'weekly', label: 'שבועי' },
  { value: 'monthly', label: 'חודשי' },
  { value: 'yearly', label: 'שנתי' },
];

export const RECURRENCE_END_TYPES: { value: RecurrenceEndType; label: string }[] = [
  { value: 'never', label: 'לעולם לא' },
  { value: 'on_date', label: 'בתאריך' },
  { value: 'after_count', label: 'אחרי מספר מופעים' },
];

/** 0=Sunday .. 6=Saturday — RTL day pills (Hebrew week starts Sunday). */
export const HE_WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export function recurrenceFrequencyLabel(f: RecurrenceFrequency): string {
  return RECURRENCE_FREQUENCIES.find((x) => x.value === f)?.label ?? f;
}

/** Compact Hebrew cadence summary — "כל שבוע · ב׳, ה׳", "כל 3 ימים", "כל חודש".
 *  Used by the recurrence tab row (frequency [+ interval] [+ weekdays]). */
export function summarizeCadence(
  frequency: RecurrenceFrequency,
  interval: number,
  byweekday: number[] | null,
): string {
  const unit: Record<RecurrenceFrequency, [string, string]> = {
    daily: ['יום', 'ימים'],
    weekly: ['שבוע', 'שבועות'],
    monthly: ['חודש', 'חודשים'],
    yearly: ['שנה', 'שנים'],
  };
  const [one, many] = unit[frequency];
  let s = interval > 1 ? `כל ${interval} ${many}` : `כל ${one}`;
  if (frequency === 'weekly' && byweekday && byweekday.length > 0) {
    s += ` · ${[...byweekday].sort((a, b) => a - b).map((d) => HE_WEEKDAYS_SHORT[d]).join(', ')}`;
  }
  return s;
}
export function recurrenceEndTypeLabel(e: RecurrenceEndType): string {
  return RECURRENCE_END_TYPES.find((x) => x.value === e)?.label ?? e;
}

/** Editable form state for the recurrence section. */
export interface RecurrenceFormState {
  enabled: boolean;
  frequency: RecurrenceFrequency;
  interval: number;
  /** Selected weekdays (0..6) — only used when frequency==='weekly'. */
  byweekday: number[];
  endType: RecurrenceEndType;
  endDate: string; // 'YYYY-MM-DD'
  endCount: number;
}

export const EMPTY_RECURRENCE: RecurrenceFormState = {
  enabled: false,
  frequency: 'weekly',
  interval: 1,
  byweekday: [],
  endType: 'never',
  endDate: '',
  endCount: 10,
};

/** Form state → the client→server rule payload (null when disabled). */
export function recurrenceFormToRule(f: RecurrenceFormState): RecurrenceRule | null {
  if (!f.enabled) return null;
  return {
    frequency: f.frequency,
    interval: Math.max(1, Math.floor(f.interval || 1)),
    byweekday:
      f.frequency === 'weekly' && f.byweekday.length > 0
        ? [...f.byweekday].sort((a, b) => a - b)
        : null,
    endType: f.endType,
    endDate: f.endType === 'on_date' ? f.endDate || null : null,
    endCount: f.endType === 'after_count' ? Math.max(1, Math.floor(f.endCount || 1)) : null,
  };
}

/** A loaded rule (from GET) → editable form state. */
export function recurrenceRuleToForm(r: RecurrenceRule): RecurrenceFormState {
  return {
    enabled: true,
    frequency: r.frequency,
    interval: r.interval,
    byweekday: r.byweekday ?? [],
    endType: r.endType,
    endDate: r.endDate ?? '',
    endCount: r.endCount ?? 10,
  };
}
