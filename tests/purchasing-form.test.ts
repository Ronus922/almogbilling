import { describe, expect, it } from 'vitest';
import { createBodySchema, draftBodySchema, updateDocumentBodySchema } from '@/lib/validation/purchasing';
import { draftsToPayload, emptyLine, type LineDraft } from '@/components/purchasing/lines';
import { supplierFieldsOf } from '@/lib/purchasing/supplier';

// The purchasing form contract: ONE body for both documents — date · supplier
// (a listed one OR a typed name) · description (optional) · due date (request) ·
// lines · notes — and nothing else.

const SUP = '11111111-1111-4111-8111-111111111111';
const rfq = (over: Record<string, unknown> = {}) => ({
  doc_type: 'rfq', doc_date: '2026-10-22', due_date: '2026-11-05', supplier_name: 'ספק ידני', title: 'צביעת חדר מדרגות',
  lines: [{ description: 'צבע', quantity: 1, unit_price: null }], ...over,
});
const po = (over: Record<string, unknown> = {}) => ({
  doc_type: 'po', doc_date: '2026-10-22', supplier_id: SUP,
  lines: [{ description: 'צבע', quantity: 1, unit_price: 10 }], ...over,
});

describe('createBodySchema', () => {
  it('needs a supplier — from the list or typed — for both documents', () => {
    expect(createBodySchema.safeParse(rfq({ supplier_name: '   ' })).success).toBe(false);
    expect(createBodySchema.safeParse(po({ supplier_id: null })).success).toBe(false);
    expect(createBodySchema.safeParse(rfq()).success).toBe(true);
    expect(createBodySchema.safeParse(rfq({ supplier_name: undefined, supplier_id: SUP })).success).toBe(true);
    expect(createBodySchema.safeParse(po({ supplier_id: null, supplier_name: 'ספק ידני' })).success).toBe(true);
  });

  it('a request needs its subject; a purchase order\'s description is optional; both are normalised', () => {
    for (const title of [undefined, '', '   ']) {
      const r = createBodySchema.safeParse(rfq({ title }));
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain('title');
    }
    const p = createBodySchema.safeParse(po());
    expect(p.success && p.data.title).toBe('');
    const t = createBodySchema.safeParse(rfq({ title: '  צביעה  ' }));
    expect(t.success && t.data.title).toBe('צביעה');
  });

  it('a draft of a request needs its subject too; a draft of an order does not', () => {
    const base = { doc_date: '2026-10-22', supplier_name: 'ספק ידני', lines: [] };
    expect(draftBodySchema.safeParse({ ...base, doc_type: 'rfq' }).success).toBe(false);
    expect(draftBodySchema.safeParse({ ...base, doc_type: 'rfq', title: 'צבע' }).success).toBe(true);
    expect(draftBodySchema.safeParse({ ...base, doc_type: 'po' }).success).toBe(true);
  });

  it('a request needs a due date, and its prices are optional', () => {
    expect(createBodySchema.safeParse(rfq({ due_date: undefined })).success).toBe(false);
    expect(createBodySchema.safeParse(rfq({ lines: [{ description: 'א', quantity: 1, unit_price: 4.5 }] })).success).toBe(true);
  });

  it('a purchase order needs a price on every line', () => {
    expect(createBodySchema.safeParse(po({ lines: [{ description: 'א', quantity: 1, unit_price: null }] })).success).toBe(false);
  });

  it('typed-supplier details are optional; a bad e-mail is refused', () => {
    const ok = createBodySchema.safeParse(rfq({ supplier_phone: '050-1', supplier_address: 'חיפה' }));
    expect(ok.success && ok.data.supplier_email).toBeNull();
    expect(createBodySchema.safeParse(rfq({ supplier_email: 'not-an-email' })).success).toBe(false);
    expect(createBodySchema.safeParse(rfq({ supplier_email: 'a@b.co' })).success).toBe(true);
  });

  it('drops fields that are not on the form', () => {
    const r = createBodySchema.safeParse(rfq({ currency: 'USD', discount: 5, tags: ['x'], bank: '12', english: true }));
    expect(r.success).toBe(true);
    if (r.success) for (const k of ['currency', 'discount', 'tags', 'bank', 'english']) expect(k in r.data).toBe(false);
  });
});

describe('updateDocumentBodySchema', () => {
  it('carries the same form fields', () => {
    expect(updateDocumentBodySchema.safeParse({ doc_date: '2026-10-22', supplier_name: 'ספק' }).success).toBe(true);
    expect(updateDocumentBodySchema.safeParse({ doc_date: '2026-10-22' }).success).toBe(false);
  });
});

describe('supplierFieldsOf', () => {
  const typed = { supplier_name: 'ידני', supplier_phone: '1', supplier_email: 'a@b.co', supplier_address: 'x' };
  it('a listed supplier carries only its id', () => {
    expect(supplierFieldsOf({ supplier_id: SUP, ...typed })).toEqual({
      supplier_id: SUP, supplier_name: null, supplier_phone: null, supplier_email: null, supplier_address: null,
    });
  });
  it('a typed supplier keeps its details on the document', () => {
    expect(supplierFieldsOf({ supplier_id: null, ...typed })).toEqual({ supplier_id: null, ...typed });
  });
});

describe('draftsToPayload (the lines of the form)', () => {
  const line = (over: Partial<LineDraft>): LineDraft => ({ ...emptyLine(), ...over });
  it('quantity defaults to 1', () => {
    expect(emptyLine().quantity).toBe('1');
  });
  it('price optional for a request, required for an order', () => {
    const d = [line({ description: 'א' })];
    expect(draftsToPayload(d, false)).toMatchObject({ ok: true, lines: [{ description: 'א', quantity: 1, unit_price: null }] });
    expect(draftsToPayload(d, true)).toMatchObject({ ok: false });
  });
  it('a filled price on a request is kept; a garbage one is refused', () => {
    expect(draftsToPayload([line({ description: 'א', unit_price: '1,250.5' })], false))
      .toMatchObject({ ok: true, lines: [{ unit_price: 1250.5 }] });
    expect(draftsToPayload([line({ description: 'א', unit_price: 'abc' })], false)).toMatchObject({ ok: false });
  });
  it('drops the blank trailing row but refuses no rows at all', () => {
    expect(draftsToPayload([line({ description: 'א' }), emptyLine()], false)).toMatchObject({ ok: true });
    expect(draftsToPayload([emptyLine()], false)).toMatchObject({ ok: false });
  });
});
