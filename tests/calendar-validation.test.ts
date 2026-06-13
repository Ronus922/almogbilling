import { describe, it, expect } from 'vitest';
import { coerceEventInput, coerceRecurrence } from '@/lib/validation/calendar';

describe('coerceEventInput — date validity', () => {
  it('accepts a real date', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-09-15' }, 'create');
    expect(r.ok).toBe(true);
  });

  it('rejects an impossible date (2026-02-30)', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-02-30' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_event_date');
  });

  it('rejects Feb 29 on a non-leap year', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-02-29' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('accepts Feb 29 on a leap year', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2028-02-29' }, 'create');
    expect(r.ok).toBe(true);
  });

  it('rejects malformed date string', () => {
    const r = coerceEventInput({ title: 'x', event_date: '15/09/2026' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('rejects end before start', () => {
    const r = coerceEventInput(
      { title: 'x', event_date: '2026-09-15', start_datetime: '2026-09-15T10:00:00Z', end_datetime: '2026-09-15T09:00:00Z' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('end_before_start');
  });
});

describe('coerceRecurrence — until_date validity', () => {
  it('rejects an impossible until_date', () => {
    const r = coerceRecurrence({ recurrence: { type: 'weekly', interval: 1, endType: 'until_date', untilDate: '2026-13-01' } });
    expect(r.ok).toBe(false);
  });

  it('accepts a valid weekly rule with count', () => {
    const r = coerceRecurrence({ recurrence: { type: 'weekly', interval: 1, endType: 'count', count: 5 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule?.count).toBe(5);
  });

  it('null recurrence → no rule', () => {
    const r = coerceRecurrence({ recurrence: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule).toBeNull();
  });
});
