import { describe, it, expect } from 'vitest';
import { coerceTaskInput, coerceRecurrence } from '@/lib/validation/tasks';

const SUPPLIER = '22222222-2222-2222-2222-222222222222';

describe('coerceTaskInput — assignees moved to the junction', () => {
  it('no longer treats assigned_to_user_id / supplier_id as task fields', () => {
    const r = coerceTaskInput(
      { title: 'נזילה', assigned_to_user_id: SUPPLIER, supplier_id: SUPPLIER },
      'create',
    );
    // The legacy keys are ignored entirely — no XOR conflict, no scalar field set.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('assigned_to_user_id' in r.fields).toBe(false);
      expect('supplier_id' in r.fields).toBe(false);
    }
  });

  it('title is still required on create', () => {
    const r = coerceTaskInput({}, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title_required');
  });

  it('still validates the non-assignee fields (e.g. status)', () => {
    const r = coerceTaskInput({ title: 'x', status: 'nope' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_status');
  });

  it('keeps debtor_id / related_entity_id coercion intact', () => {
    const r = coerceTaskInput({ debtor_id: 'not-a-uuid' }, 'update');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_debtor_id');
  });
});

describe('coerceRecurrence', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    frequency: 'weekly', interval: 1, endType: 'never', ...over,
  });

  it('is tri-state: absent leaves the series alone, null ends it', () => {
    expect(coerceRecurrence({})).toBeNull();
    expect(coerceRecurrence({ recurrence: null })).toEqual({ ok: true, rule: null });
  });

  // The quarter / half-year cadences ride on the existing interval, so they must
  // pass the unchanged validator — no new frequency values were introduced.
  it('accepts the quarter and half-year cadences as monthly intervals', () => {
    for (const interval of [3, 6, 12]) {
      const r = coerceRecurrence({ recurrence: rec({ frequency: 'monthly', interval }) });
      expect(r?.ok, `monthly/${interval}`).toBe(true);
      if (r?.ok) expect(r.rule?.interval).toBe(interval);
    }
  });

  it('rejects an unknown frequency and an out-of-range interval', () => {
    expect(coerceRecurrence({ recurrence: rec({ frequency: 'quarterly' }) }))
      .toEqual({ ok: false, error: 'invalid_recurrence_frequency' });
    expect(coerceRecurrence({ recurrence: rec({ interval: 0 }) }))
      .toEqual({ ok: false, error: 'invalid_recurrence_interval' });
  });

  it('keeps byweekday for weekly only, deduped and sorted', () => {
    const weekly = coerceRecurrence({ recurrence: rec({ byweekday: [4, 1, 4] }) });
    expect(weekly?.ok && weekly.rule?.byweekday).toEqual([1, 4]);
    const monthly = coerceRecurrence({
      recurrence: rec({ frequency: 'monthly', byweekday: [1, 4] }),
    });
    expect(monthly?.ok && monthly.rule?.byweekday).toBeNull();
  });

  it('requires a well-formed end bound for each end type', () => {
    expect(coerceRecurrence({ recurrence: rec({ endType: 'on_date', endDate: '15/08/2026' }) }))
      .toEqual({ ok: false, error: 'invalid_recurrence_end_date' });
    expect(coerceRecurrence({ recurrence: rec({ endType: 'after_count', endCount: 0 }) }))
      .toEqual({ ok: false, error: 'invalid_recurrence_end_count' });
    const ok = coerceRecurrence({ recurrence: rec({ endType: 'after_count', endCount: 5 }) });
    expect(ok?.ok && ok.rule?.endCount).toBe(5);
  });
});
