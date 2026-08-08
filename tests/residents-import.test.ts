import { describe, it, expect } from 'vitest';
import {
  mapResidentRole,
  parseResidentRow,
  aggregateResidentRows,
  normalizeApartmentKey,
  ROLE_LABELS,
} from '@/lib/residents/import-runner';

// The residents import is row-per-person: A apartment · B name · C phone ·
// D role in Hebrew. These tests drive the PURE parse/aggregate helpers the
// runner is built on — no DB, no Excel file. The merge itself (non-empty
// overwrites, empty preserves) is the upsert's coalesce and is not re-tested
// here; what matters is that each row produces the right payload fields.

describe('mapResidentRole', () => {
  it('maps by Hebrew substring so inflections work', () => {
    expect(mapResidentRole('בעל')).toBe('owner');
    expect(mapResidentRole('בעלים')).toBe('owner');
    expect(mapResidentRole('בעל דירה')).toBe('owner');
    expect(mapResidentRole('שוכר')).toBe('tenant');
    expect(mapResidentRole('שוכרת')).toBe('tenant');
    expect(mapResidentRole('מפעיל')).toBe('operator');
  });

  it('defaults empty role to owner', () => {
    expect(mapResidentRole(null)).toBe('owner');
    expect(mapResidentRole('')).toBe('owner');
    expect(mapResidentRole('   ')).toBe('owner');
  });

  it('returns null for an unrecognized value', () => {
    expect(mapResidentRole('גנן')).toBeNull();
    expect(mapResidentRole('owner')).toBeNull();
  });
});

describe('parseResidentRow', () => {
  it('skips a row with an empty apartment (column A)', () => {
    expect(parseResidentRow([null, 'ישראל', '0541234567', 'בעל'])).toEqual({ kind: 'skipped' });
    expect(parseResidentRow(['   ', 'ישראל', null, null])).toEqual({ kind: 'skipped' });
  });

  it('skips a row with apartment+role but neither name nor phone', () => {
    expect(parseResidentRow(['12', null, null, 'שוכר'])).toEqual({ kind: 'skipped' });
    expect(parseResidentRow(['12', '  ', '  ', null])).toEqual({ kind: 'skipped' });
  });

  it('fails an unrecognized non-empty role with the exact Hebrew message', () => {
    expect(parseResidentRow(['7', 'ישראל', null, 'גנן'])).toEqual({
      kind: 'failed',
      apartment_number: '7',
      error: 'תפקיד לא מזוהה: גנן',
    });
  });

  it('fails a non-empty invalid phone with validatePhone Hebrew error', () => {
    const r = parseResidentRow(['7', 'ישראל', '12345', 'בעל']);
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.apartment_number).toBe('7');
      expect(r.error).toBe('מספר הטלפון קצר מדי');
    }
  });

  it('normalizes a valid phone and keeps empty cells null', () => {
    expect(parseResidentRow(['3', 'דנה', '054-123-4567', 'שוכרת'])).toEqual({
      kind: 'ok',
      apartment_number: '3',
      role: 'tenant',
      name: 'דנה',
      phone: '0541234567',
    });
    // name only — phone simply not sent
    expect(parseResidentRow(['3', 'דנה', null, 'מפעיל'])).toEqual({
      kind: 'ok',
      apartment_number: '3',
      role: 'operator',
      name: 'דנה',
      phone: null,
    });
  });

  it('treats an empty role as owner', () => {
    const r = parseResidentRow(['9', 'משה', '0521112233', null]);
    expect(r).toEqual({
      kind: 'ok',
      apartment_number: '9',
      role: 'owner',
      name: 'משה',
      phone: '0521112233',
    });
  });
});

describe('aggregateResidentRows', () => {
  it('builds the merge payload fields per role', () => {
    const { groups, failedRows, skipped } = aggregateResidentRows([
      ['5', 'אבי הבעלים', '0541111111', 'בעל דירה'],
      ['5', 'שרה השוכרת', '0522222222', 'שוכרת'],
      ['5', 'חברת ניהול', '039999999', 'מפעיל'],
    ]);
    expect(failedRows).toEqual([]);
    expect(skipped).toBe(0);
    expect(groups).toHaveLength(1);
    expect(groups[0].apartment_number).toBe('5');
    expect(groups[0].fields).toEqual({
      owner_name: 'אבי הבעלים',
      owner_phone: '0541111111',
      tenant_name: 'שרה השוכרת',
      tenant_phone: '0522222222',
      operator_name: 'חברת ניהול',
      operator_phone: '039999999',
    });
    expect(groups[0].rows).toEqual([2, 3, 4]);
  });

  it('duplicate (apartment, role): first occurrence wins, the dup fails', () => {
    const { groups, failedRows } = aggregateResidentRows([
      ['8', 'ראשון', '0541111111', 'בעל'],
      ['8', 'שני', '0522222222', 'בעלים'],
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields).toEqual({ owner_name: 'ראשון', owner_phone: '0541111111' });
    expect(failedRows).toEqual([
      {
        row: 3,
        apartment_number: '8',
        error: `דירה 8 עם תפקיד ${ROLE_LABELS.owner} מופיעה יותר מפעם אחת בקובץ`,
      },
    ]);
  });

  it('invalid phone: the row contributes nothing, other rows of the apartment still apply', () => {
    const { groups, failedRows } = aggregateResidentRows([
      ['4', 'בעל פגום', '12345', 'בעל'],
      ['4', 'שוכר תקין', '0533334444', 'שוכר'],
    ]);
    expect(failedRows).toEqual([
      { row: 2, apartment_number: '4', error: 'מספר הטלפון קצר מדי' },
    ]);
    expect(groups).toHaveLength(1);
    // no phantom owner fields from the failed row
    expect(groups[0].fields).toEqual({ tenant_name: 'שוכר תקין', tenant_phone: '0533334444' });
  });

  it('a failed row does not lock its role — a later valid row is not a dup', () => {
    const { groups, failedRows } = aggregateResidentRows([
      ['4', 'בעל פגום', '12345', 'בעל'],
      ['4', 'בעל תקין', '0541234567', 'בעל'],
    ]);
    expect(failedRows).toHaveLength(1);
    expect(groups[0].fields).toEqual({ owner_name: 'בעל תקין', owner_phone: '0541234567' });
  });

  it('counts skipped rows: empty apartment, and name+phone both empty', () => {
    const { groups, failedRows, skipped } = aggregateResidentRows([
      [null, 'בלי דירה', '0541234567', 'בעל'],
      ['6', null, null, 'שוכר'],
      ['6', 'תקין', null, 'בעל'],
    ]);
    expect(skipped).toBe(2);
    expect(failedRows).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields).toEqual({ owner_name: 'תקין' });
    expect(groups[0].rows).toEqual([4]);
  });

  it('groups apartment spellings by normalized key so one upsert runs per apartment', () => {
    expect(normalizeApartmentKey('05')).toBe('5');
    expect(normalizeApartmentKey('דירה 5')).toBe('5');
    const { groups } = aggregateResidentRows([
      ['5', 'בעל', '0541111111', 'בעל'],
      ['05', 'שוכר', '0522222222', 'שוכר'],
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields).toEqual({
      owner_name: 'בעל',
      owner_phone: '0541111111',
      tenant_name: 'שוכר',
      tenant_phone: '0522222222',
    });
  });
});
