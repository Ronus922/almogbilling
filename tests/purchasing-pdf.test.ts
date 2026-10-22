import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { renderDocumentPdf, type PdfInput } from '@/lib/purchasing/pdf';
import { EMPTY_COMPANY } from '@/lib/purchasing/model';

// 1×1 PNG (valid) — stands in for the logo / signature.
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64',
));

const base: PdfInput = {
  kind: 'po', number: 12, date: '2026-10-21', title: 'חומרי ניקוי לחודש נובמבר', notes: 'אספקה עד סוף החודש.\nנא לתאם מראש טלפונית.',
  dueDate: null, vatRate: 18,
  company: { ...EMPTY_COMPANY, name: 'ועד הבית מגדל אלמוג בע״מ', tax_id: '514123456', address: 'דרך הים 12, חיפה', phone: '04-8123456', email: 'office@almog-haifa.co.il', website: 'www.almog-haifa.co.il' },
  logo: PNG, signature: PNG,
  supplier: { name: 'נקיון מהיר בע״מ (Clean Fast)', address: 'הנגב 5, חיפה', phone: '050-1234567' },
  lines: [
    { description: 'נוזל רצפות לימון 4 ליטר', quantity: 12, unit_price: 24.9 },
    { description: 'שקיות אשפה 120 ליטר, גליל של 20 יחידות, שחור, חזק במיוחד לשימוש בחדר האשפה המרכזי של הבניין', quantity: 30, unit_price: 18 },
    { description: 'מטליות Microfiber', quantity: 100, unit_price: 3.5 },
  ],
};

describe('renderDocumentPdf', () => {
  it('produces a PDF for a purchase order and an unpriced request', () => {
    const po = renderDocumentPdf(base);
    expect(po.subarray(0, 5).toString()).toBe('%PDF-');
    const rfq = renderDocumentPdf({ ...base, kind: 'rfq', number: 3, dueDate: '2026-11-01', supplier: null,
      lines: base.lines.map((l) => ({ ...l, unit_price: null })) });
    expect(rfq.subarray(0, 5).toString()).toBe('%PDF-');
    if (process.env.PDF_OUT_DIR) {
      writeFileSync(`${process.env.PDF_OUT_DIR}/po.pdf`, po);
      writeFileSync(`${process.env.PDF_OUT_DIR}/rfq.pdf`, rfq);
    }
  });

  it('prints a request with optional prices, a typed supplier and no description', () => {
    const rfq = renderDocumentPdf({
      ...base, kind: 'rfq', number: 10002, title: '', dueDate: '2026-11-01',
      supplier: { name: 'ספק שלא ברשימה', address: '', phone: '' },
      lines: [{ description: 'עם מחיר', quantity: 2, unit_price: 10 }, { description: 'בלי מחיר', quantity: 1, unit_price: null }],
    });
    expect(rfq.subarray(0, 5).toString()).toBe('%PDF-');
    if (process.env.PDF_OUT_DIR) writeFileSync(`${process.env.PDF_OUT_DIR}/rfq-priced.pdf`, rfq);
  });

  it('survives a long list over several pages and a missing logo', () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ description: `פריט מספר ${i + 1}`, quantity: i + 1, unit_price: 10 }));
    const pdf = renderDocumentPdf({ ...base, logo: null, signature: null, lines });
    expect(pdf.length).toBeGreaterThan(5000);
  });
});
