import { describe, it, expect } from 'vitest';
import {
  cadenceKind,
  cadenceLabel,
  cadenceChips,
  cadenceWindow,
  expectedPerPeriod,
  HE_WEEKDAYS_SHORT,
  type ChipStrip,
} from '@/lib/recurrence/cadence';
import type { RecurrenceRule } from '@/lib/recurrence/engine';
import {
  presetToRule,
  recurrenceFormToRule,
  recurrenceRuleToForm,
  EMPTY_RECURRENCE,
} from '@/lib/constants/recurrence';

type CadenceInput = Pick<RecurrenceRule, 'frequency' | 'interval' | 'byweekday'>;

const cadence = (over: Partial<CadenceInput> = {}): CadenceInput => ({
  frequency: 'weekly',
  interval: 1,
  byweekday: null,
  ...over,
});

/** The active weekday indices of a weekday strip. */
function activeDays(chips: ChipStrip): number[] {
  if (chips.type !== 'weekdays') throw new Error(`expected weekdays, got ${chips.type}`);
  return chips.days.filter((d) => d.state !== 'off').map((d) => d.index);
}

/** The active month numbers of a months strip. */
function activeMonths(chips: ChipStrip): number[] {
  if (chips.type !== 'months') throw new Error(`expected months, got ${chips.type}`);
  return chips.months.filter((m) => m.state !== 'off').map((m) => m.month);
}

describe('cadenceKind — quarter/half-year are monthly intervals, not frequencies', () => {
  it('maps the stored (frequency, interval) onto the cadence it reads as', () => {
    expect(cadenceKind('daily', 1)).toBe('daily');
    expect(cadenceKind('weekly', 1)).toBe('weekly');
    expect(cadenceKind('monthly', 1)).toBe('monthly');
    expect(cadenceKind('monthly', 3)).toBe('quarterly');
    expect(cadenceKind('monthly', 6)).toBe('half_yearly');
    expect(cadenceKind('monthly', 12)).toBe('yearly');
    expect(cadenceKind('yearly', 1)).toBe('yearly');
  });

  it('falls back to custom for intervals with no named cadence', () => {
    expect(cadenceKind('daily', 5)).toBe('custom');
    expect(cadenceKind('weekly', 2)).toBe('custom');
    expect(cadenceKind('monthly', 4)).toBe('custom');
    expect(cadenceKind('yearly', 2)).toBe('custom');
  });
});

describe('cadenceLabel', () => {
  it('names the six cadences', () => {
    expect(cadenceLabel('daily', 1)).toBe('כל יום');
    expect(cadenceLabel('weekly', 1)).toBe('כל שבוע');
    expect(cadenceLabel('monthly', 1)).toBe('כל חודש');
    expect(cadenceLabel('monthly', 3)).toBe('כל רבעון');
    expect(cadenceLabel('monthly', 6)).toBe('כל חצי שנה');
    expect(cadenceLabel('yearly', 1)).toBe('כל שנה');
  });

  it('pluralizes custom intervals', () => {
    expect(cadenceLabel('daily', 5)).toBe('כל 5 ימים');
    expect(cadenceLabel('weekly', 2)).toBe('כל 2 שבועות');
    expect(cadenceLabel('monthly', 4)).toBe('כל 4 חודשים');
  });
});

// The three cases below are read straight off the reference design. They are the
// evidence that the chips need no bymonth / bymonthday columns — the anchor plus
// the interval already encode them.
describe('cadenceChips — reference design cases', () => {
  it('monthly, anchor 2026-08-15 → "ב-15 לחודש"', () => {
    expect(cadenceChips(cadence({ frequency: 'monthly' }), '2026-08-15')).toEqual({
      type: 'monthday',
      label: 'ב-15 לחודש',
    });
  });

  it('half-yearly (monthly/6), anchor month 09 → months 3 and 9', () => {
    const chips = cadenceChips(cadence({ frequency: 'monthly', interval: 6 }), '2026-09-01');
    expect(activeMonths(chips)).toEqual([3, 9]);
  });

  it('quarterly (monthly/3), anchor month 10 → months 1, 4, 7, 10', () => {
    const chips = cadenceChips(cadence({ frequency: 'monthly', interval: 3 }), '2026-10-01');
    expect(activeMonths(chips)).toEqual([1, 4, 7, 10]);
  });
});

describe('cadenceChips', () => {
  it('renders all twelve month chips so the inactive ones stay visible', () => {
    const chips = cadenceChips(cadence({ frequency: 'monthly', interval: 3 }), '2026-10-01');
    if (chips.type !== 'months') throw new Error('expected months');
    expect(chips.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(chips.months.filter((m) => m.state === 'off')).toHaveLength(8);
  });

  it('daily lights every weekday', () => {
    const chips = cadenceChips(cadence({ frequency: 'daily' }), '2026-06-14');
    expect(activeDays(chips)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('weekly lights the selected weekdays', () => {
    const chips = cadenceChips(cadence({ byweekday: [2, 4] }), '2026-06-14');
    expect(activeDays(chips)).toEqual([2, 4]);
  });

  it('weekly with no selection falls back to the anchor weekday, like the engine', () => {
    // 2026-06-17 is a Wednesday → weekday 3.
    const chips = cadenceChips(cadence({ byweekday: null }), '2026-06-17');
    expect(activeDays(chips)).toEqual([3]);
  });

  it('labels the weekday chips right-to-left from Sunday', () => {
    const chips = cadenceChips(cadence({ frequency: 'daily' }), '2026-06-14');
    if (chips.type !== 'weekdays') throw new Error('expected weekdays');
    expect(chips.days.map((d) => d.label)).toEqual(HE_WEEKDAYS_SHORT);
  });

  it('marks a completed occurrence green and leaves the rest scheduled', () => {
    // 2026-06-16 is a Tuesday (2), 2026-06-18 a Thursday (4).
    const chips = cadenceChips(cadence({ byweekday: [2, 4] }), '2026-06-16', ['2026-06-16']);
    if (chips.type !== 'weekdays') throw new Error('expected weekdays');
    expect(chips.days[2].state).toBe('done');
    expect(chips.days[4].state).toBe('on');
    expect(chips.days[0].state).toBe('off');
  });

  it('yields no grid for a custom interval, and none for an unparseable anchor', () => {
    expect(cadenceChips(cadence({ frequency: 'daily', interval: 5 }), '2026-06-14'))
      .toEqual({ type: 'none' });
    expect(cadenceChips(cadence({ frequency: 'monthly' }), 'not-a-date'))
      .toEqual({ type: 'none' });
  });
});

describe('cadenceWindow', () => {
  it('spans Sunday to Saturday for the day-grid cadences', () => {
    // 2026-06-17 is a Wednesday.
    expect(cadenceWindow('weekly', 1, '2026-06-17'))
      .toEqual({ from: '2026-06-14', to: '2026-06-20', label: 'השבוע' });
    expect(cadenceWindow('daily', 1, '2026-06-17')?.label).toBe('השבוע');
  });

  it('does not slide the window when today IS the Sunday or the Saturday', () => {
    expect(cadenceWindow('weekly', 1, '2026-06-14')?.from).toBe('2026-06-14');
    expect(cadenceWindow('weekly', 1, '2026-06-20')?.to).toBe('2026-06-20');
  });

  it('spans the calendar month for monthly, including a short February', () => {
    expect(cadenceWindow('monthly', 1, '2026-02-10'))
      .toEqual({ from: '2026-02-01', to: '2026-02-28', label: 'החודש' });
  });

  it('spans the calendar year for quarter / half-year / year', () => {
    expect(cadenceWindow('monthly', 3, '2026-06-17'))
      .toEqual({ from: '2026-01-01', to: '2026-12-31', label: 'השנה' });
    expect(cadenceWindow('yearly', 1, '2026-06-17')?.label).toBe('השנה');
  });

  it('has no window for a custom interval', () => {
    expect(cadenceWindow('daily', 5, '2026-06-17')).toBeNull();
  });
});

describe('expectedPerPeriod — drives whether the progress badge shows at all', () => {
  it('counts the selected weekdays for weekly, and all seven for daily', () => {
    expect(expectedPerPeriod(cadence({ byweekday: [2, 3, 4] }))).toBe(3);
    expect(expectedPerPeriod(cadence({ byweekday: null }))).toBe(1);
    expect(expectedPerPeriod(cadence({ frequency: 'daily' }))).toBe(7);
  });

  it('counts occurrences per year for the month-grid cadences', () => {
    expect(expectedPerPeriod(cadence({ frequency: 'monthly', interval: 3 }))).toBe(4);
    expect(expectedPerPeriod(cadence({ frequency: 'monthly', interval: 6 }))).toBe(2);
  });

  it('is <= 1 wherever a badge would be noise, and 0 for custom', () => {
    // The badge renders only when expected > 1 — this is what keeps "1/1 החודש"
    // off monthly cards, matching the reference design.
    expect(expectedPerPeriod(cadence({ frequency: 'monthly' }))).toBe(1);
    expect(expectedPerPeriod(cadence({ frequency: 'yearly' }))).toBe(1);
    expect(expectedPerPeriod(cadence({ frequency: 'daily', interval: 5 }))).toBe(0);
  });
});

describe('form presets ↔ stored rule', () => {
  it('maps each preset onto its stored (frequency, interval)', () => {
    expect(presetToRule('quarterly', 1)).toEqual({ frequency: 'monthly', interval: 3 });
    expect(presetToRule('half_yearly', 1)).toEqual({ frequency: 'monthly', interval: 6 });
    expect(presetToRule('yearly', 1)).toEqual({ frequency: 'yearly', interval: 1 });
  });

  it('ignores the interval field for presets that ARE the interval', () => {
    // The "כל כמה" input is hidden for these, but a stale value must not leak.
    expect(presetToRule('quarterly', 9)).toEqual({ frequency: 'monthly', interval: 3 });
    expect(presetToRule('daily', 9)).toEqual({ frequency: 'daily', interval: 9 });
  });

  it('round-trips every named cadence through the form', () => {
    for (const preset of ['daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly'] as const) {
      const rule = recurrenceFormToRule({ ...EMPTY_RECURRENCE, enabled: true, preset });
      expect(rule, preset).not.toBeNull();
      expect(recurrenceRuleToForm(rule!).preset, preset).toBe(preset);
    }
  });

  it('round-trips a custom interval without renaming it', () => {
    const rule = recurrenceFormToRule({
      ...EMPTY_RECURRENCE, enabled: true, preset: 'daily', interval: 5,
    });
    const form = recurrenceRuleToForm(rule!);
    expect(form.preset).toBe('daily');
    expect(form.interval).toBe(5);
  });

  it('drops byweekday for non-weekly presets', () => {
    const rule = recurrenceFormToRule({
      ...EMPTY_RECURRENCE, enabled: true, preset: 'quarterly', byweekday: [1, 3],
    });
    expect(rule?.byweekday).toBeNull();
  });

  it('returns null when recurrence is switched off', () => {
    expect(recurrenceFormToRule(EMPTY_RECURRENCE)).toBeNull();
  });
});
