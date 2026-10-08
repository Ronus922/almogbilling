import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Debtor } from '@/lib/db/debtors';
import { unpaidMonthsByType } from '@/lib/export/unpaid-months';
import {
  DEBTOR_EXCEL_COLUMNS,
  DEBTOR_EXPORT_COLUMNS,
  buildDebtorsWorkbook,
} from '@/lib/export/debtors-export';

// The two "חודשים שלא שולמו" columns of the debtors Excel (08/10/2026), derived
// from the Bllink texts a row already carries: hot water = the periods of the
// "מים חמים …" items of `details` (column H); management fees = `monthly_debt`
// (column F, "חודשי פיגור") as Bllink states it. The fixtures reproduce the text
// SHAPES Bllink writes; apartments, amounts and names are synthetic.

describe('unpaidMonthsByType', () => {
  it('lists every hot-water period and passes the management range through', () => {
    expect(unpaidMonthsByType({
      details: 'מים חמים 01-02/26, מים חמים 03-04/26, מים חמים 05-06/26, מים חמים 07-08/26',
      monthly_debt: '4/26 - 10/26',
      total_debt: 4321,
    })).toEqual({
      hotWater: '01-02/26, 03-04/26, 05-06/26, 07-08/26',
      managementFees: '4/26 - 10/26',
    });
  });

  it('strips the "לתקופה" variant and a doubled space, keeps the item order', () => {
    expect(unpaidMonthsByType({
      details: 'מים חמים  01-02/25, מים חמים 05-06/25, מים חמים לתקופה 07-08/25, מים חמים 11-12/25',
      monthly_debt: '1/25 - 10/26',
      total_debt: 7000,
    })).toEqual({
      hotWater: '01-02/25, 05-06/25, 07-08/25, 11-12/25',
      managementFees: '1/25 - 10/26',
    });
  });

  it('keeps a qualifier that follows the period ("הערכה")', () => {
    expect(unpaidMonthsByType({
      details: 'מים חמים 5-6/26 הערכה, מים חמים 07-08/26 הערכה',
      monthly_debt: null,
      total_debt: 180,
    })).toEqual({ hotWater: '5-6/26 הערכה, 07-08/26 הערכה', managementFees: '' });
  });

  it('turns a space-separated month list into a comma list, leaves a range alone', () => {
    expect(unpaidMonthsByType({ details: null, monthly_debt: '1/25 9/26 10/26', total_debt: 2000 }).managementFees)
      .toBe('1/25, 9/26, 10/26');
    expect(unpaidMonthsByType({ details: null, monthly_debt: '5/25 - 3/26', total_debt: 9000 }).managementFees)
      .toBe('5/25 - 3/26');
    expect(unpaidMonthsByType({ details: null, monthly_debt: '10/26', total_debt: 800 }).managementFees)
      .toBe('10/26');
  });

  it('ignores an item that is not labelled as hot water', () => {
    expect(unpaidMonthsByType({
      details: 'חוב מיוחד 05/26, מים חמים 07-08/26, E2E-DETAILS מים חמים 09-10/26',
      monthly_debt: null,
      total_debt: 100,
    }).hotWater).toBe('07-08/26');
  });

  it('is empty when the row carries no text', () => {
    for (const details of [null, undefined, '', '  ']) {
      for (const monthly of [null, undefined, '', ' ']) {
        expect(unpaidMonthsByType({ details, monthly_debt: monthly, total_debt: 500 }))
          .toEqual({ hotWater: '', managementFees: '' });
      }
    }
    // A label with nothing after it is not a period.
    expect(unpaidMonthsByType({ details: 'מים חמים', monthly_debt: null, total_debt: 5 }).hotWater).toBe('');
  });

  it('shows nothing next to a ₪0 (or negative) balance — the card’s gate', () => {
    for (const total of [0, -50, null, undefined]) {
      expect(unpaidMonthsByType({
        details: 'מים חמים 07-08/26',
        monthly_debt: '9/26 - 10/26',
        total_debt: total,
      })).toEqual({ hotWater: '', managementFees: '' });
    }
  });

  it('normalises stray whitespace inside the texts', () => {
    expect(unpaidMonthsByType({
      details: '  מים חמים   05-06/26 ,מים חמים 07-08/26  ',
      monthly_debt: '  9/26   -  10/26 ',
      total_debt: 300,
    })).toEqual({ hotWater: '05-06/26, 07-08/26', managementFees: '9/26 - 10/26' });
  });
});

function debtor(over: Partial<Debtor>): Debtor {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    apartment_number: '990101',
    owner_name: 'בעלים לדוגמה',
    tenant_name: null,
    address: null,
    phone_owner: '0501234567',
    phone_tenant: null,
    email_owner: null,
    email_tenant: null,
    total_debt: 4321,
    management_fees: 3700,
    hot_water_debt: 621,
    special_debt: 0,
    monthly_debt: '4/26 - 10/26',
    details: 'מים חמים 01-02/26, מים חמים 03-04/26, מים חמים 05-06/26, מים חמים 07-08/26',
    legal_status_id: null,
    legal_status_name: 'מכתב התראה',
    legal_status_color: null,
    legal_status_is_default: null,
    next_action_description: null,
    next_action_date: null,
    is_archived: false,
    archived_at: null,
    last_imported_at: null,
    doc_count: 0,
    last_doc_at: null,
    ...over,
  };
}

const EXCEL_HEADERS = [
  'מס׳ דירה', 'שם בעל הדירה', 'טלפון', 'סה״כ חוב',
  'דמי ניהול', 'חודשים שלא שולמו — דמי ניהול',
  'מים חמים', 'חודשים שלא שולמו — מים חמים',
  'מצב משפטי',
];

describe('debtors Excel export — the two months columns', () => {
  it('adds the two columns next to their money columns and leaves PDF/print untouched', () => {
    expect(DEBTOR_EXCEL_COLUMNS.map((c) => c.header)).toEqual(EXCEL_HEADERS);
    expect(DEBTOR_EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      'מס׳ דירה', 'שם בעל הדירה', 'טלפון', 'סה״כ חוב', 'דמי ניהול', 'מים חמים', 'מצב משפטי',
    ]);
    // The existing columns keep their relative order in the Excel list.
    const existing = DEBTOR_EXCEL_COLUMNS.filter((c) => DEBTOR_EXPORT_COLUMNS.includes(c));
    expect(existing).toEqual(DEBTOR_EXPORT_COLUMNS);
  });

  it('writes the months as text cells, the money as numbers, and a blank cell when there is nothing', async () => {
    const rows = [
      debtor({}),
      debtor({
        id: '00000000-0000-4000-8000-000000000002',
        apartment_number: '990102', total_debt: 1500, management_fees: 1500, hot_water_debt: 0,
        monthly_debt: '10/26', details: null, legal_status_name: null,
      }),
      debtor({
        id: '00000000-0000-4000-8000-000000000003',
        apartment_number: '990103', total_debt: 0, management_fees: 0, hot_water_debt: 0,
        monthly_debt: '9/26', details: 'מים חמים 07-08/26',
      }),
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildDebtorsWorkbook(rows));
    const ws = wb.getWorksheet('חייבים');
    expect(ws, 'sheet "חייבים"').toBeDefined();
    expect(ws!.views[0]?.rightToLeft).toBe(true);

    const cells = (r: number) => EXCEL_HEADERS.map((_, i) => ws!.getRow(r).getCell(i + 1));
    expect(cells(1).map((c) => c.value)).toEqual(EXCEL_HEADERS);

    const first = cells(2);
    expect(first.map((c) => c.value)).toEqual([
      '990101', 'בעלים לדוגמה', '050-123-4567', 4321,
      3700, '4/26 - 10/26',
      621, '01-02/26, 03-04/26, 05-06/26, 07-08/26',
      'מכתב התראה',
    ]);
    for (const i of [5, 7]) {
      expect(first[i]!.type, `column ${i + 1} is a string cell`).toBe(ExcelJS.ValueType.String);
      expect(first[i]!.numFmt, `column ${i + 1} is formatted as text`).toBe('@');
    }
    for (const i of [3, 4, 6]) {
      expect(first[i]!.type, `column ${i + 1} stays numeric`).toBe(ExcelJS.ValueType.Number);
    }
    // The pre-existing columns are written as before — no text format was added to them.
    for (const i of [0, 1, 2, 3, 4, 6, 8]) {
      expect(first[i]!.numFmt ?? 'General', `column ${i + 1} keeps its format`).toBe('General');
    }

    // Management months only, no hot-water items → that cell is truly blank.
    const second = cells(3);
    expect(second.map((c) => c.value)).toEqual(['990102', 'בעלים לדוגמה', '050-123-4567', 1500, 1500, '10/26', 0, null, '—']);
    expect(second[7]!.type).toBe(ExcelJS.ValueType.Null);
    expect(second[7]!.numFmt, 'a blank months cell still carries the text format').toBe('@');
    // Settled apartment: both months cells blank even though the texts are still stored.
    expect(cells(4).slice(4, 8).map((c) => c.value)).toEqual([0, null, 0, null]);
  });
});
