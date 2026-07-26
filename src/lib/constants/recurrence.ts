import type {
  RecurrenceEndType, RecurrenceFrequency, RecurrenceRule,
} from '@/lib/recurrence/engine';
import { cadenceKind, type CadenceKind } from '@/lib/recurrence/cadence';

// Form state + labels for the task-recurrence UI (RecurrenceSection). Kept in the
// tasks domain (independent of the calendar's own recurrence constants).
//
// The picker offers CADENCE PRESETS rather than the raw stored frequency, because
// "רבעוני" and "חצי-שנתי" are not separate frequencies — they are `monthly` with
// interval 3 / 6. The mapping is one function each way, and the reverse direction
// reuses `cadenceKind` so the form and the display strip can never disagree
// (Iron Rule #8 — DRY).

/** What the user picks. Every value maps onto a stored (frequency, interval). */
export type CadencePreset = Exclude<CadenceKind, 'custom'>;

export const RECURRENCE_PRESETS: { value: CadencePreset; label: string }[] = [
  { value: 'daily', label: 'יומי' },
  { value: 'weekly', label: 'שבועי' },
  { value: 'monthly', label: 'חודשי' },
  { value: 'quarterly', label: 'רבעוני' },
  { value: 'half_yearly', label: 'חצי-שנתי' },
  { value: 'yearly', label: 'שנתי' },
];

const PRESET_RULE: Record<CadencePreset, { frequency: RecurrenceFrequency; interval: number }> = {
  daily: { frequency: 'daily', interval: 1 },
  weekly: { frequency: 'weekly', interval: 1 },
  monthly: { frequency: 'monthly', interval: 1 },
  quarterly: { frequency: 'monthly', interval: 3 },
  half_yearly: { frequency: 'monthly', interval: 6 },
  yearly: { frequency: 'yearly', interval: 1 },
};

/** Only the day/week presets take a custom "every N" — the rest ARE the interval. */
export const PRESETS_WITH_INTERVAL: readonly CadencePreset[] = ['daily', 'weekly'];

export function recurrencePresetLabel(p: CadencePreset): string {
  return RECURRENCE_PRESETS.find((x) => x.value === p)?.label ?? p;
}

export const RECURRENCE_END_TYPES: { value: RecurrenceEndType; label: string }[] = [
  { value: 'never', label: 'לעולם לא' },
  { value: 'on_date', label: 'בתאריך' },
  { value: 'after_count', label: 'אחרי מספר מופעים' },
];

export function recurrenceEndTypeLabel(e: RecurrenceEndType): string {
  return RECURRENCE_END_TYPES.find((x) => x.value === e)?.label ?? e;
}

/** Editable form state for the recurrence section. */
export interface RecurrenceFormState {
  enabled: boolean;
  preset: CadencePreset;
  /** "כל כמה" — only meaningful (and only shown) for the daily/weekly presets. */
  interval: number;
  /** Selected weekdays (0..6) — only used by the weekly preset. */
  byweekday: number[];
  endType: RecurrenceEndType;
  endDate: string; // 'YYYY-MM-DD'
  endCount: number;
}

export const EMPTY_RECURRENCE: RecurrenceFormState = {
  enabled: false,
  preset: 'weekly',
  interval: 1,
  byweekday: [],
  endType: 'never',
  endDate: '',
  endCount: 10,
};

/** The (frequency, interval) a form state stores as. */
export function presetToRule(
  preset: CadencePreset,
  interval: number,
): { frequency: RecurrenceFrequency; interval: number } {
  const base = PRESET_RULE[preset];
  return PRESETS_WITH_INTERVAL.includes(preset)
    ? { frequency: base.frequency, interval: Math.max(1, Math.floor(interval || 1)) }
    : base;
}

/** Form state → the client→server rule payload (null when disabled). */
export function recurrenceFormToRule(f: RecurrenceFormState): RecurrenceRule | null {
  if (!f.enabled) return null;
  const { frequency, interval } = presetToRule(f.preset, f.interval);
  return {
    frequency,
    interval,
    byweekday:
      frequency === 'weekly' && f.byweekday.length > 0
        ? [...f.byweekday].sort((a, b) => a - b)
        : null,
    endType: f.endType,
    endDate: f.endType === 'on_date' ? f.endDate || null : null,
    endCount: f.endType === 'after_count' ? Math.max(1, Math.floor(f.endCount || 1)) : null,
  };
}

/** A loaded rule (from GET) → editable form state. A rule that doesn't match a
 *  named cadence (e.g. every 5 days) keeps its frequency as the preset and its
 *  raw interval, so it round-trips unchanged. */
export function recurrenceRuleToForm(r: RecurrenceRule): RecurrenceFormState {
  const kind = cadenceKind(r.frequency, r.interval);
  const preset: CadencePreset = kind === 'custom' ? r.frequency : kind;
  return {
    enabled: true,
    preset,
    interval: r.interval,
    byweekday: r.byweekday ?? [],
    endType: r.endType,
    endDate: r.endDate ?? '',
    endCount: r.endCount ?? 10,
  };
}
