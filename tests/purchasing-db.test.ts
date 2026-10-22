import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The purchasing persistence layer (src/lib/db/purchasing.ts) against a real
// database:
//   • numbering — one atomic series per document type, the first document asks
//     for a start number, parallel saves never collide, a deleted document's
//     number is never reissued, the two series are independent;
//   • the supplier's public context is resolved from the token ALONE and never
//     exposes another request;
//   • quotes — one per (request, supplier), replaced wholesale, a deleted
//     winner clears the choice;
//   • the descriptions feed the autocomplete.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL). Everything it
// creates is removed by the exact ids it recorded (CLAUDE.md iron rule 12), and
// the two sequence rows are restored to what they were.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
}));

const db = await import('@/lib/db/purchasing');
const { buildComparison } = await import('@/lib/purchasing/model');

const made = { docs: [] as string[], suppliers: [] as string[] };
let admin = '';
let before: Array<{ doc_type: string; last_number: number }> = [];

const lines = (n = 2) => Array.from({ length: n }, (_, i) => ({ description: `פריט בדיקה ${i + 1}`, quantity: i + 1, unit_price: null }));
const rfqInput = (over: Partial<Parameters<typeof db.createDocument>[0]> = {}) => ({
  doc_type: 'rfq' as const, doc_date: '2026-10-21', title: 'בדיקה', supplier_id: null, supplier_name: 'ספק ידני לבדיקה',
  supplier_phone: null, supplier_email: null, supplier_address: null, notes: '', due_date: '2099-01-01',
  vat_rate: 18, source_rfq_id: null, start_number: null, lines: lines(), ...over,
});

d('purchasing db', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => undefined);
    admin = await requireSeededAdmin(pool);
    before = (await pool.query(`select doc_type, last_number from public.purchasing_sequences`)).rows;
    await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq','po')`);
    for (const name of ['ספק בדיקה א׳', 'ספק בדיקה ב׳']) {
      const r = await pool.query<{ id: string }>(
        `insert into public.suppliers (display_name) values ($1) returning id`, [name],
      );
      made.suppliers.push(r.rows[0].id);
    }
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.docs.length) await pool.query(`delete from public.purchasing_documents where id = any($1::uuid[])`, [made.docs]);
    if (made.suppliers.length) await pool.query(`delete from public.suppliers where id = any($1::uuid[])`, [made.suppliers]);
    await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq','po')`);
    for (const row of before) {
      await pool.query(`insert into public.purchasing_sequences (doc_type, last_number) values ($1, $2)`, [row.doc_type, row.last_number]);
    }
    await pool.end();
  });

  const create = async (over: Parameters<typeof rfqInput>[0] = {}) => {
    const r = await db.createDocument(rfqInput(over), admin);
    made.docs.push(r.id);
    return r;
  };

  it('asks for a start number on the first document of a series, then runs on its own', async () => {
    await expect(db.createDocument(rfqInput(), admin)).rejects.toBeInstanceOf(db.StartNumberRequiredError);
    expect((await db.getSequenceState()).rfq).toBeNull();
    const first = await create({ start_number: 100 });
    expect(first.number).toBe(100);
    // A later start_number is ignored: the series already runs.
    const second = await create({ start_number: 5000 });
    expect(second.number).toBe(101);
    expect((await db.getSequenceState()).rfq).toBe(101);
  });

  it('keeps the two series independent', async () => {
    const po = await create({
      doc_type: 'po', supplier_id: made.suppliers[0], due_date: null, start_number: 7,
      lines: [{ description: 'חומר', quantity: 2, unit_price: 10 }],
    });
    expect(po.number).toBe(7);
    expect((await db.getSequenceState())).toEqual({ rfq: 101, po: 7 });
  });

  it('never hands the same number to parallel saves', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => db.createDocument(rfqInput(), admin)));
    for (const r of results) made.docs.push(r.id);
    const numbers = results.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual([102, 103, 104, 105, 106, 107, 108, 109]);
  });

  it('never reissues the number of a deleted document', async () => {
    const last = await create();
    expect(last.number).toBe(110);
    expect(await db.softDeleteDocument(last.id)).toBe(true);
    const next = await create();
    expect(next.number).toBe(111);
    expect(await db.findDocument(last.id)).toBeNull();
  });

  it('rolls the number back with a failed insert', async () => {
    const seq = (await db.getSequenceState()).rfq;
    await expect(db.createDocument(rfqInput({ lines: [{ description: '', quantity: 1, unit_price: null }] }), admin)).rejects.toThrow();
    expect((await db.getSequenceState()).rfq).toBe(seq);
  });

  describe('the supplier link', () => {
    it('is one stable token per (request, supplier) and resolves only its own request', async () => {
      const a = await create({ title: 'בקשה א' });
      const b = await create({ title: 'בקשה ב' });
      const r1 = await db.ensureRecipient(a.id, made.suppliers[0]);
      const again = await db.ensureRecipient(a.id, made.suppliers[0]);
      expect(again.token).toBe(r1.token);
      expect(r1.token.length).toBeGreaterThanOrEqual(43);
      const rB = await db.ensureRecipient(b.id, made.suppliers[0]);
      expect(rB.token).not.toBe(r1.token);

      const ctxA = await db.findPublicContext(r1.token);
      expect(ctxA?.rfq.id).toBe(a.id);
      expect(ctxA?.rfq.title).toBe('בקשה א');
      expect(ctxA?.lines).toHaveLength(2);
      // Nothing of request B / another supplier is in A's context.
      expect(JSON.stringify(ctxA)).not.toContain(b.id);
      expect(JSON.stringify(ctxA)).not.toContain(made.suppliers[1]);
    });

    it('is not found for a malformed, unknown or deleted token', async () => {
      expect(await db.findPublicContext('short')).toBeNull();
      expect(await db.findPublicContext('x'.repeat(43))).toBeNull();
      const a = await create();
      const r = await db.ensureRecipient(a.id, made.suppliers[0]);
      expect(await db.findPublicContext(r.token)).not.toBeNull();
      await db.softDeleteDocument(a.id);
      expect(await db.findPublicContext(r.token)).toBeNull();
    });
  });

  describe('quotes, comparison and the winner', () => {
    it('keeps one quote per supplier, replaces its prices, and compares with a lump sum', async () => {
      const rfq = await create();
      const ls = await db.listLines(rfq.id);
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[0], source: 'portal', total_amount: null, valid_until: '2099-02-01',
        notes: 'ראשונה', prices: { [ls[0].id]: 10, [ls[1].id]: 20 }, actor_id: null,
      });
      // Amended: same supplier, new prices — still ONE quote.
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[0], source: 'portal', total_amount: null, valid_until: null,
        notes: 'מתוקנת', prices: { [ls[0].id]: 8, [ls[1].id]: 20 }, actor_id: null,
      });
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[1], source: 'manual', total_amount: 40, valid_until: null,
        notes: '', prices: {}, actor_id: admin,
      });
      const quotes = await db.listQuotes(rfq.id);
      expect(quotes).toHaveLength(2);
      const a = quotes.find((q) => q.supplier_id === made.suppliers[0])!;
      expect(a.notes).toBe('מתוקנת');
      expect(a.prices).toEqual({ [ls[0].id]: 8, [ls[1].id]: 20 });

      const cols = buildComparison(
        ls.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity })),
        db.toCompareQuotes(quotes),
      );
      const byName = Object.fromEntries(cols.map((c) => [c.supplier_id, c]));
      // qty 1 × 8 + qty 2 × 20 = 48 vs lump sum 40.
      expect(byName[made.suppliers[0]].total).toBe(48);
      expect(byName[made.suppliers[1]].total).toBe(40);
      expect(byName[made.suppliers[1]].cheapest).toBe(true);
      expect(byName[made.suppliers[1]].lineTotals).toEqual([null, null]);

      await db.setWinner(rfq.id, made.suppliers[1], admin);
      const won = await db.findDocument(rfq.id);
      expect(won?.winner_supplier_id).toBe(made.suppliers[1]);
      expect(won?.winner_chosen_at).not.toBeNull();
      // Deleting the winner's quote clears the choice with it.
      await db.deleteQuote(rfq.id, made.suppliers[1]);
      const cleared = await db.findDocument(rfq.id);
      expect(cleared?.winner_supplier_id).toBeNull();
      expect(cleared?.winner_chosen_at).toBeNull();
    });
  });

  it('suggests descriptions entered before, most used first', async () => {
    await create({ lines: [{ description: 'נוזל רצפות ייחודי לבדיקה', quantity: 1, unit_price: null }] });
    await create({ lines: [{ description: 'נוזל רצפות ייחודי לבדיקה', quantity: 3, unit_price: null }] });
    const hits = await db.suggestDescriptions('ייחודי לבד');
    expect(hits[0]).toBe('נוזל רצפות ייחודי לבדיקה');
    expect(await db.suggestDescriptions('%')).toBeInstanceOf(Array);
  });

  describe('the supplier of a document (list or typed by hand)', () => {
    it('keeps a hand-typed supplier on the document only, and never adds it to suppliers', async () => {
      const before = (await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n;
      const rfq = await create({
        supplier_name: 'ספק שלא ברשימה', supplier_phone: '050-1234567', supplier_email: 'x@example.com', supplier_address: 'רחוב הבדיקה 1',
      });
      const row = await db.findDocument(rfq.id);
      expect(row?.supplier_id).toBeNull();
      expect(row?.supplier_name).toBe('ספק שלא ברשימה');
      expect(row?.supplier_phone).toBe('050-1234567');
      expect(row?.supplier_email).toBe('x@example.com');
      expect(row?.supplier_address).toBe('רחוב הבדיקה 1');
      expect((await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n).toBe(before);
    });

    it('a purchase order may carry a typed supplier; a list supplier reads its live name', async () => {
      const typed = await create({
        doc_type: 'po', due_date: null, supplier_name: 'ספק ידני להזמנה',
        lines: [{ description: 'חומר', quantity: 1, unit_price: 5 }],
      });
      expect((await db.findDocument(typed.id))?.supplier_name).toBe('ספק ידני להזמנה');
      const listed = await create({
        doc_type: 'po', due_date: null, supplier_id: made.suppliers[0], supplier_name: null,
        lines: [{ description: 'חומר', quantity: 1, unit_price: 5 }],
      });
      const row = await db.findDocument(listed.id);
      expect(row?.supplier_id).toBe(made.suppliers[0]);
      expect(row?.supplier_name).toBe('ספק בדיקה א׳');
    });

    it('refuses a document with no supplier at all', async () => {
      await expect(db.createDocument(rfqInput({ supplier_id: null, supplier_name: null, start_number: 1 }), admin)).rejects.toThrow();
    });

    it('the description is optional, and a request line may carry an optional price', async () => {
      const rfq = await create({ title: '', lines: [{ description: 'עם מחיר', quantity: 2, unit_price: 12.5 }, { description: 'בלי', quantity: 1, unit_price: null }] });
      const row = await db.findDocument(rfq.id);
      expect(row?.title).toBe('');
      const ls = await db.listLines(rfq.id);
      expect(ls.map((l) => l.unit_price)).toEqual([12.5, null]);
      const stored = await pool.query(`select title from public.purchasing_documents where id = $1`, [rfq.id]);
      expect(stored.rows[0].title).toBeNull();
    });

    it('an edit switches between a list supplier and a typed one', async () => {
      const rfq = await create({ supplier_id: made.suppliers[0], supplier_name: null });
      await db.updateDocument(rfq.id, {
        doc_date: '2026-10-22', title: 'חדש', supplier_id: null, supplier_name: 'ספק אחר', supplier_phone: null,
        supplier_email: null, supplier_address: null, notes: 'n', due_date: null,
      });
      const row = await db.findDocument(rfq.id);
      expect(row?.supplier_id).toBeNull();
      expect(row?.supplier_name).toBe('ספק אחר');
      expect(row?.doc_date).toBe('2026-10-22');
      expect(row?.due_date).toBe('2099-01-01');
    });
  });

  it('a file belongs to exactly one owner', async () => {
    const rfq = await create();
    await expect(pool.query(
      `insert into public.purchasing_files (object_key, original_filename, mime_type, file_size, uploaded_via)
       values ('00000000-0000-4000-8000-000000000001.pdf', 'a.pdf', 'application/pdf', 10, 'staff')`,
    )).rejects.toThrow();
    const row = await db.insertFile({
      document_id: rfq.id, quote_id: null, object_key: '00000000-0000-4000-8000-0000000000a1.pdf',
      original_filename: 'שרטוט.pdf', mime_type: 'application/pdf', file_size: 10, uploaded_via: 'staff', uploaded_by: admin,
    });
    expect((await db.listDocumentFiles(rfq.id)).map((f) => f.id)).toEqual([row.id]);
    await db.deleteFileRow(row.id);
    expect(await db.listDocumentFiles(rfq.id)).toHaveLength(0);
  });
});
