import { describe, expect, it } from 'vitest';
import {
  FINANCE_RECEIPT_ACCEPT, FINANCE_RECEIPT_LIMITS, receiptCanonicalMime, receiptExt,
  validateFinanceReceipt, validateFinanceReceiptSet,
} from '@/lib/constants/finance';

const MB = 1024 * 1024;

describe('finance receipt policy', () => {
  it('accepts PDF / JPG / PNG and nothing else', () => {
    expect(validateFinanceReceipt({ name: 'קבלה.pdf', size: 10 * MB, type: 'application/pdf' })).toBeNull();
    expect(validateFinanceReceipt({ name: 'IMG_1.JPG', size: 3 * MB, type: 'image/jpeg' })).toBeNull();
    expect(validateFinanceReceipt({ name: 'scan.png', size: 1000, type: '' })).toBeNull();
    expect(validateFinanceReceipt({ name: 'sheet.xlsx', size: 1000, type: '' })).toMatch(/אינו נתמך/);
    expect(validateFinanceReceipt({ name: 'noext', size: 1000, type: 'application/pdf' })).toMatch(/אינו נתמך/);
    expect(FINANCE_RECEIPT_ACCEPT).toBe('.pdf,.jpg,.jpeg,.png');
  });

  it('the extension decides the MIME; a contradicting browser MIME is refused', () => {
    expect(receiptExt('a.b.PDF')).toBe('pdf');
    expect(receiptCanonicalMime('jpeg')).toBe('image/jpeg');
    expect(receiptCanonicalMime('gif')).toBeNull();
    expect(validateFinanceReceipt({ name: 'x.pdf', size: 10, type: 'image/png' })).toMatch(/אינו תואם/);
    expect(validateFinanceReceipt({ name: 'x.pdf', size: 10, type: 'application/octet-stream' })).toBeNull();
  });

  it('enforces the per-file cap and refuses empty files', () => {
    expect(validateFinanceReceipt({ name: 'x.pdf', size: 0, type: '' })).toMatch(/ריק/);
    expect(validateFinanceReceipt({ name: 'x.pdf', size: FINANCE_RECEIPT_LIMITS.maxBytes, type: '' })).toBeNull();
    expect(validateFinanceReceipt({ name: 'x.pdf', size: FINANCE_RECEIPT_LIMITS.maxBytes + 1, type: '' })).toMatch(/50MB/);
  });

  it('caps the number of files per entry at 5', () => {
    const four = Array.from({ length: 4 }, () => ({ size: 1 }));
    expect(validateFinanceReceiptSet(four, [{ size: 1 }])).toBeNull();
    expect(validateFinanceReceiptSet(four, [{ size: 1 }, { size: 1 }])).toMatch(/עד 5 קבצים/);
    expect(validateFinanceReceiptSet(four, [{ size: 1 }], 4)).toMatch(/עד 4 קבצים/);
  });
});
