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

const notices: Array<Record<string, unknown>> = [];
vi.mock('@/services/notifications', () => ({
  createNotification: vi.fn(async (input: Record<string, unknown>) => { notices.push(input); }),
}));

const db = await import('@/lib/db/purchasing');
const notify = await import('@/lib/purchasing/notify');
const { buildComparison } = await import('@/lib/purchasing/model');

const made = { docs: [] as string[], suppliers: [] as string[] };
let admin = '';
let before: Array<{ doc_type: string; last_number: number }> = [];

const lines = (n = 2) => Array.from({ length: n }, (_, i) => ({ description: `פריט בדיקה ${i + 1}`, quantity: i + 1, unit_price: null }));
const rfqInput = (over: Partial<Parameters<typeof db.createDocument>[0]> = {}) => ({
  doc_type: 'rfq' as const, status: 'issued' as 'draft' | 'issued', doc_date: '2026-10-21', title: 'בדיקה', supplier_id: null, supplier_name: 'ספק ידני לבדיקה',
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
    const numbers = results.map((r) => r.number as number).sort((a, b) => a - b);
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
    it('keeps the price mode and the typed prices beside the normalised ones', async () => {
      const rfq = await create();
      const ls = await db.listLines(rfq.id);
      const id = await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[0], source: 'portal', total_amount: null, valid_until: null, notes: '',
        prices: { [ls[0].id]: 100, [ls[1].id]: 50 }, price_mode: 'incl', entered_prices: { [ls[0].id]: 118, [ls[1].id]: 59 }, actor_id: null,
      });
      let q = (await db.listQuotes(rfq.id)).find((x) => x.id === id)!;
      expect(q.price_mode).toBe('incl');
      expect(q.prices).toEqual({ [ls[0].id]: 100, [ls[1].id]: 50 });
      expect(q.entered_prices).toEqual({ [ls[0].id]: 118, [ls[1].id]: 59 });
      // A later upsert without a mode (staff entry) is before VAT, typed = stored.
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[0], source: 'manual', total_amount: null, valid_until: null, notes: '',
        prices: { [ls[0].id]: 7, [ls[1].id]: 9 }, actor_id: admin,
      });
      q = (await db.listQuotes(rfq.id)).find((x) => x.id === id)!;
      expect(q.price_mode).toBe('excl');
      expect(q.entered_prices).toEqual(q.prices);
      await expect(pool.query(`update public.purchasing_quotes set price_mode = 'gross' where id = $1`, [id])).rejects.toThrow();
    });

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

    it('refuses an order with no supplier at all', async () => {
      await expect(db.createDocument(rfqInput({ doc_type: 'po', supplier_id: null, supplier_name: null, start_number: 1 }), admin)).rejects.toThrow();
    });

    it('soft-deletes a legacy issued document that has no supplier, yet still refuses to issue a new one without', async () => {
      const doc = await create({ doc_type: 'po', start_number: 700 });
      // Reproduce the legacy row: issued, no supplier, written before the NOT VALID
      // constraint existed. The constraint is dropped and re-added verbatim.
      const def = (await pool.query<{ d: string }>(
        `select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'purchasing_documents_has_supplier'`,
      )).rows[0].d;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier`);
        await c.query(`update public.purchasing_documents set supplier_id = null, supplier_name = null where id = $1`, [doc.id]);
        await c.query(`alter table public.purchasing_documents add constraint purchasing_documents_has_supplier ${def}`);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
      expect(await db.softDeleteDocument(doc.id)).toBe(true);
      expect((await pool.query(`select deleted_at from public.purchasing_documents where id = $1`, [doc.id])).rows[0].deleted_at).not.toBeNull();

      const draft = await create({ doc_type: 'po', status: 'draft', supplier_name: null });
      await expect(db.updateDocument(draft.id, {
        doc_date: '2026-10-21', title: 'x', supplier_id: null, supplier_name: null, supplier_phone: null, supplier_email: null,
        supplier_address: null, notes: '', due_date: '2099-01-01', lines: undefined,
        issue: { start_number: 1, vat_rate: 18 },
      })).rejects.toThrow();
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

  describe('drafts on the server', () => {
    const upd = (over: Partial<Parameters<typeof db.updateDocument>[1]> = {}) => ({
      doc_date: '2026-10-22', title: 'טיוטה', supplier_id: null, supplier_name: 'ספק טיוטה', supplier_phone: null,
      supplier_email: null, supplier_address: null, notes: '', due_date: '2099-01-01', ...over,
    });

    it('a draft takes no number, shows in the list first, and leaves the series untouched', async () => {
      const seq = await db.getSequenceState();
      const dr = await create({ status: 'draft', supplier_name: null, title: 'טיוטה בלי ספק', due_date: null, lines: [] });
      expect(dr.number).toBeNull();
      expect(await db.getSequenceState()).toEqual(seq);
      const row = await db.findDocument(dr.id);
      expect(row).toMatchObject({ status: 'draft', number: null, supplier_name: null });
      const list = await db.listDocuments('rfq');
      expect(list[0].id).toBe(dr.id); // drafts first
      expect(list.filter((d2) => d2.status === 'draft').every((d2) => d2.number === null)).toBe(true);
    });

    it('is edited in place, then issued: the number is allocated only now, atomically with the update', async () => {
      const dr = await create({ status: 'draft', title: 'לפני הפקה', lines: lines(1) });
      const seq = (await db.getSequenceState()).rfq as number;
      await db.updateDocument(dr.id, upd({ title: 'עודכן', lines: [{ description: 'שורה חדשה', quantity: 2, unit_price: null }] }));
      expect((await db.findDocument(dr.id))?.status).toBe('draft');
      expect((await db.getSequenceState()).rfq).toBe(seq);

      const done = await db.updateDocument(dr.id, upd({ title: 'הופק', issue: { start_number: null, vat_rate: 17 } }));
      expect(done?.number).toBe(seq + 1);
      const row = await db.findDocument(dr.id);
      expect(row).toMatchObject({ status: 'issued', number: seq + 1, vat_rate: 17, title: 'הופק' });
      expect((await db.listLines(dr.id)).map((l) => l.description)).toEqual(['שורה חדשה']);
      // …and it cannot be issued twice (no second number is burnt).
      await expect(db.updateDocument(dr.id, upd({ issue: { start_number: null, vat_rate: 17 } }))).rejects.toBeInstanceOf(db.NotADraftError);
      expect((await db.getSequenceState()).rfq).toBe(seq + 1);
    });

    it('the first document of a series asks for a start number when a draft is issued', async () => {
      await pool.query(`delete from public.purchasing_sequences where doc_type = 'po'`);
      const dr = await create({
        status: 'draft', doc_type: 'po', due_date: null, lines: [{ description: 'חומר', quantity: 1, unit_price: 3 }],
      });
      await expect(db.updateDocument(dr.id, upd({ due_date: null, issue: { start_number: null, vat_rate: 18 } })))
        .rejects.toBeInstanceOf(db.StartNumberRequiredError);
      expect((await db.findDocument(dr.id))?.status).toBe('draft'); // rolled back
      const done = await db.updateDocument(dr.id, upd({ due_date: null, issue: { start_number: 41, vat_rate: 18 } }));
      expect(done?.number).toBe(41);
    });

    it('a draft is deleted for good; an issued document is only soft-deleted', async () => {
      const dr = await create({ status: 'draft' });
      const seq = await db.getSequenceState();
      expect(await db.softDeleteDocument(dr.id)).toBe(false); // not for drafts
      expect(await db.deleteDraft(dr.id)).toBe(true);
      expect((await pool.query(`select 1 from public.purchasing_documents where id = $1`, [dr.id])).rowCount).toBe(0);
      expect(await db.getSequenceState()).toEqual(seq);
      const issued = await create();
      expect(await db.deleteDraft(issued.id)).toBe(false);
    });

    it('a draft has no public link: its token (if any) resolves to nothing', async () => {
      const dr = await create({ status: 'draft' });
      const r = await db.ensureRecipient(dr.id, made.suppliers[0]);
      expect(await db.findPublicContext(r.token)).toBeNull();
    });
  });

  describe('a hand-typed supplier is a party like any other (no row in suppliers)', () => {
    const manual = { key: 'mtest00001', name: 'ספק ידני לינק', phone: '050-1112233', email: 'manual@example.com', address: 'רחוב 1' };

    it('has one stable personal link per request, details refreshed on a re-send', async () => {
      const suppliersBefore = (await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n;
      const rfq = await create();
      const r1 = await db.ensureRecipient(rfq.id, null, manual);
      expect(r1).toMatchObject({ supplier_id: null, supplier_name: 'ספק ידני לינק' });
      const r2 = await db.ensureRecipient(rfq.id, null, { ...manual, name: 'שם מעודכן' });
      expect(r2.token).toBe(r1.token);
      expect(r2.supplier_name).toBe('שם מעודכן');
      expect((await db.listRecipients(rfq.id))).toHaveLength(1);
      // a listed supplier next to it is a separate recipient
      await db.ensureRecipient(rfq.id, made.suppliers[0]);
      expect((await db.listRecipients(rfq.id))).toHaveLength(2);

      const ctx = await db.findPublicContext(r1.token);
      expect(ctx?.recipient).toMatchObject({ supplier_id: null, supplier_name: 'שם מעודכן' });
      expect(ctx?.recipient.party?.email).toBe('manual@example.com');
      expect((await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n).toBe(suppliersBefore);
    });

    it('submits a quote through its link, is compared, wins and carries the choice to the order', async () => {
      const rfq = await create();
      const ls = await db.listLines(rfq.id);
      const rec = await db.ensureRecipient(rfq.id, null, manual);
      const ctx = await db.findPublicContext(rec.token);
      const qid = await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: null, party: ctx?.recipient.party, source: 'portal', total_amount: null,
        valid_until: null, notes: '', prices: { [ls[0].id]: 5, [ls[1].id]: 6 }, actor_id: null,
      });
      // amended through the same link: still ONE manual quote
      expect(await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: null, party: ctx?.recipient.party, source: 'portal', total_amount: null,
        valid_until: null, notes: 'תיקון', prices: { [ls[0].id]: 4, [ls[1].id]: 6 }, actor_id: null,
      })).toBe(qid);
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: made.suppliers[0], source: 'portal', total_amount: null, valid_until: null, notes: '',
        prices: { [ls[0].id]: 9, [ls[1].id]: 9 }, actor_id: null,
      });
      const quotes = await db.listQuotes(rfq.id);
      expect(quotes).toHaveLength(2);
      const m = quotes.find((q) => q.supplier_id === null)!;
      expect(m).toMatchObject({ supplier_name: 'ספק ידני לינק', notes: 'תיקון' });
      expect((await db.findQuote(rfq.id, manual.key))?.id).toBe(qid);

      const cols = buildComparison(ls.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity })), db.toCompareQuotes(quotes));
      expect(cols.find((c) => c.supplier_id === manual.key)).toMatchObject({ supplier_name: 'ספק ידני לינק', cheapest: true });

      await db.setWinner(rfq.id, manual.key, admin);
      let doc = await db.findDocument(rfq.id);
      expect(doc).toMatchObject({ winner_manual: true, winner_supplier_id: null, winner_manual_key: manual.key, winner_supplier_name: 'ספק ידני לינק' });
      expect(doc?.winner_chosen_at).not.toBeNull();
      // switching to a listed winner, then deleting the manual quote keeps that winner
      await db.setWinner(rfq.id, made.suppliers[0], admin);
      doc = await db.findDocument(rfq.id);
      expect(doc).toMatchObject({ winner_manual: false, winner_supplier_id: made.suppliers[0] });
      await db.deleteQuote(rfq.id, manual.key);
      expect((await db.findDocument(rfq.id))?.winner_supplier_id).toBe(made.suppliers[0]);
      // deleting the manual WINNER's quote clears the choice
      await db.upsertQuote({
        rfq_id: rfq.id, supplier_id: null, party: manual, source: 'portal', total_amount: null, valid_until: null, notes: '',
        prices: { [ls[0].id]: 1, [ls[1].id]: 1 }, actor_id: null,
      });
      await db.setWinner(rfq.id, manual.key, admin);
      await db.deleteQuote(rfq.id, manual.key);
      expect(await db.findDocument(rfq.id)).toMatchObject({ winner_manual: false, winner_chosen_at: null });
    });

    it('is logged in the dispatch list under its own name', async () => {
      const rfq = await create();
      await db.logDispatch({ document_id: rfq.id, supplier_id: null, supplier_name: 'ספק ידני לינק', channel: 'email', status: 'failed', error: 'אין מייל', sent_by: admin });
      const list = await db.listDispatches(rfq.id);
      expect(list[0]).toMatchObject({ supplier_id: null, supplier_name: 'ספק ידני לינק', status: 'failed' });
    });

    it('the schema refuses a nameless / keyless hand-typed recipient and a repeated key', async () => {
      const rfq = await create();
      await expect(pool.query(
        `insert into public.purchasing_rfq_recipients (rfq_id, supplier_id, token) values ($1, null, $2)`, [rfq.id, 'x'.repeat(43)],
      )).rejects.toThrow();
      await expect(pool.query(
        `insert into public.purchasing_rfq_recipients (rfq_id, supplier_id, token, supplier_name) values ($1, null, $2, 'ללא מפתח')`,
        [rfq.id, 'w'.repeat(43)],
      )).rejects.toThrow();
      await db.ensureRecipient(rfq.id, null, manual);
      await expect(pool.query(
        `insert into public.purchasing_rfq_recipients (rfq_id, supplier_id, manual_key, token, supplier_name) values ($1, null, $2, $3, 'עוד')`,
        [rfq.id, manual.key, 'y'.repeat(43)],
      )).rejects.toThrow();
    });

    it('a request carries as many hand-typed suppliers as it likes, each with its own link, quote and win', async () => {
      const rfq = await create();
      const ls = await db.listLines(rfq.id);
      const a = { key: 'mmulti0001', name: 'ראשון', phone: '050-1', email: 'a@example.com', address: '' };
      const b = { key: 'mmulti0002', name: 'שני', phone: '050-2', email: 'b@example.com', address: '' };
      const ra = await db.ensureRecipient(rfq.id, null, a);
      const rb = await db.ensureRecipient(rfq.id, null, b);
      expect(ra.token).not.toBe(rb.token);
      expect((await db.listRecipients(rfq.id)).map((r) => r.supplier_name).sort()).toEqual(['ראשון', 'שני']);
      const ctxB = await db.findPublicContext(rb.token);
      expect(ctxB?.recipient.party).toMatchObject({ key: b.key, name: 'שני', email: 'b@example.com' });

      for (const [who, price] of [[a, 5], [b, 3]] as const) {
        await db.upsertQuote({
          rfq_id: rfq.id, supplier_id: null, party: who, source: 'portal', total_amount: null, valid_until: null, notes: '',
          prices: { [ls[0].id]: price, [ls[1].id]: price }, actor_id: null,
        });
      }
      const quotes = await db.listQuotes(rfq.id);
      expect(quotes.map((q) => q.manual_key).sort()).toEqual([a.key, b.key]);
      // the comparison has a column per typed supplier and the cheaper one is flagged
      const cols = buildComparison(ls.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity })), db.toCompareQuotes(quotes));
      expect(cols.map((c) => c.supplier_id).sort()).toEqual([a.key, b.key]);
      expect(cols.find((c) => c.cheapest)?.supplier_id).toBe(b.key);

      await db.setWinner(rfq.id, b.key, admin);
      expect(await db.findDocument(rfq.id)).toMatchObject({ winner_manual: true, winner_manual_key: b.key, winner_supplier_name: 'שני' });
      // removing the OTHER typed supplier's quote leaves the winner alone, removing the winner's clears it
      await db.deleteQuote(rfq.id, a.key);
      expect((await db.findDocument(rfq.id))?.winner_manual_key).toBe(b.key);
      await db.deleteQuote(rfq.id, b.key);
      expect(await db.findDocument(rfq.id)).toMatchObject({ winner_manual: false, winner_manual_key: null, winner_chosen_at: null });
      const stats = await db.getRfqAnswerStats(rfq.id);
      expect(stats).toEqual({ recipients: 2, answered: 0 });
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

  describe('the suppliers and "send by" ticks chosen on a request\'s form', () => {
    const typedA = { supplier_id: null, key: 'mform00001', name: 'מוקלד א', phone: '050-1', email: 'a@example.com' };
    const typedB = { supplier_id: null, key: 'mform00002', name: 'מוקלד ב', phone: null, email: null };
    const requestInput = (over: Partial<Parameters<typeof db.createDocument>[0]> = {}) =>
      rfqInput({ supplier_name: null, ...over });

    it('a draft keeps its suppliers (listed + typed) and its ticks; none of it enters suppliers', async () => {
      const suppliersBefore = (await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n;
      const dr = await create(requestInput({
        status: 'draft', recipients: [{ supplier_id: made.suppliers[0], key: null, name: null, phone: null, email: null }, typedA],
        send_email: true, send_whatsapp: false,
      }));
      const doc = await db.findDocument(dr.id);
      expect(doc).toMatchObject({ status: 'draft', send_email: true, send_whatsapp: false, supplier_id: null, supplier_name: null });
      const recs = await db.listRecipients(dr.id);
      expect(recs.map((r) => r.supplier_name).sort()).toEqual(['מוקלד א', 'ספק בדיקה א׳']);
      expect(recs.find((r) => r.manual_key === typedA.key)).toMatchObject({ supplier_phone: '050-1', supplier_email: 'a@example.com', sent_at: null });
      expect((await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n).toBe(suppliersBefore);
    });

    it('saving the draft again makes the suppliers exactly the new set, keeping the links of those that stay', async () => {
      const dr = await create(requestInput({ status: 'draft', recipients: [typedA, typedB] }));
      const tokenA = (await db.listRecipients(dr.id)).find((r) => r.manual_key === typedA.key)!.token;
      const form = (over: Partial<Parameters<typeof db.updateDocument>[1]> = {}) => ({
        doc_date: '2026-10-21', title: 'בדיקה', notes: '', due_date: '2099-01-01', supplier_id: null, supplier_name: null,
        supplier_phone: null, supplier_email: null, supplier_address: null, ...over,
      });
      await db.updateDocument(dr.id, form({
        recipients: [{ ...typedA, name: 'מוקלד א (תוקן)' }, { supplier_id: made.suppliers[1], key: null, name: null, phone: null, email: null }],
        send_whatsapp: true,
      }));
      const recs = await db.listRecipients(dr.id);
      expect(recs.map((r) => r.supplier_name).sort()).toEqual(['מוקלד א (תוקן)', 'ספק בדיקה ב׳']);
      expect(recs.find((r) => r.manual_key === typedA.key)?.token).toBe(tokenA);
      expect(await db.findDocument(dr.id)).toMatchObject({ send_email: false, send_whatsapp: true });
    });

    it('issuing the draft keeps its suppliers and ticks; an issued request\'s suppliers are not rewritten', async () => {
      const dr = await create(requestInput({ status: 'draft', recipients: [typedA], send_email: true }));
      const issued = await db.updateDocument(dr.id, {
        doc_date: '2026-10-21', title: 'בדיקה', notes: '', due_date: '2099-01-01', supplier_id: null, supplier_name: null,
        supplier_phone: null, supplier_email: null, supplier_address: null, recipients: [typedA, typedB],
        issue: { start_number: 500, vat_rate: 18 },
      });
      expect(issued?.number).not.toBeNull();
      expect((await db.listRecipients(dr.id))).toHaveLength(2);
      expect(await db.findDocument(dr.id)).toMatchObject({ status: 'issued', send_email: true });
      await expect(db.updateDocument(dr.id, {
        doc_date: '2026-10-21', title: 'בדיקה', notes: '', due_date: '2099-01-01', supplier_id: null, supplier_name: null,
        supplier_phone: null, supplier_email: null, supplier_address: null, recipients: [typedA],
      })).rejects.toThrow();
      expect((await db.listRecipients(dr.id))).toHaveLength(2);
    });

    it('a request needs no supplier of its own (its suppliers are its recipients), an order still does', async () => {
      const rfq = await create(requestInput({ recipients: [typedA] }));
      expect(await db.findDocument(rfq.id)).toMatchObject({ status: 'issued', supplier_id: null, supplier_name: null });
      await expect(db.createDocument({ ...rfqInput({ supplier_name: null }), doc_type: 'po', start_number: 900, lines: [{ description: 'א', quantity: 1, unit_price: 1 }] }, admin))
        .rejects.toThrow();
    });

    it('"sent" follows the dispatch log, and the lines lock once something was sent or a quote exists', async () => {
      const rfq = await create(requestInput({ recipients: [typedA, typedB] }));
      expect(await db.isRfqLocked(rfq.id)).toBe(false);
      await db.logDispatch({ document_id: rfq.id, supplier_id: null, manual_key: typedA.key, supplier_name: 'מוקלד א', channel: 'email', status: 'failed', error: 'x', sent_by: admin });
      expect(await db.isRfqLocked(rfq.id)).toBe(false);
      await db.logDispatch({ document_id: rfq.id, supplier_id: null, manual_key: typedA.key, supplier_name: 'מוקלד א', channel: 'whatsapp', status: 'sent', error: null, sent_by: admin });
      const recs = await db.listRecipients(rfq.id);
      expect(recs.find((r) => r.manual_key === typedA.key)?.sent_at).not.toBeNull();
      expect(recs.find((r) => r.manual_key === typedB.key)?.sent_at).toBeNull();
      expect(await db.isRfqLocked(rfq.id)).toBe(true);

      const other = await create(requestInput({ recipients: [typedA] }));
      expect(await db.isRfqLocked(other.id)).toBe(false);
      await db.upsertQuote({
        rfq_id: other.id, supplier_id: null, party: { key: typedA.key, name: 'מוקלד א', phone: null, email: null, address: null },
        source: 'manual', total_amount: 10, valid_until: null, notes: '', prices: {}, actor_id: null,
      });
      expect(await db.isRfqLocked(other.id)).toBe(true);
    });
  });

  describe('new quotes and the notices to the creator', () => {
    const quote = (rfq_id: string, supplier_id: string, source: 'portal' | 'manual') =>
      db.upsertQuote({ rfq_id, supplier_id, source, total_amount: source === 'manual' ? 100 : null, valid_until: null, notes: '', prices: {}, actor_id: null });
    const tick = () => new Promise((r) => setTimeout(r, 25));
    const listed = async (id: string) => (await db.listDocuments('rfq')).find((d) => d.id === id)!;

    it('a portal quote is new until the request is opened; a staff-entered one never is', async () => {
      const [a, b] = made.suppliers;
      const rfq = await create({ title: 'נושא חדשות' });
      await db.ensureRecipient(rfq.id, a);
      await db.ensureRecipient(rfq.id, b);
      expect((await listed(rfq.id)).unseen_quote_count).toBe(0);
      const baseline = await db.countRfqsWithUnseenQuotes();

      await quote(rfq.id, b, 'manual');
      expect((await listed(rfq.id)).unseen_quote_count).toBe(0);
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline);

      await quote(rfq.id, a, 'portal');
      expect((await listed(rfq.id)).unseen_quote_count).toBe(1);
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline + 1);

      await db.markQuotesSeen(rfq.id);
      expect((await listed(rfq.id)).unseen_quote_count).toBe(0);
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline);

      // An amendment is news again.
      await tick();
      await quote(rfq.id, a, 'portal');
      expect((await listed(rfq.id)).unseen_quote_count).toBe(1);
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline + 1);
      await db.markQuotesSeen(rfq.id);
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline);
    });

    it('a draft and a purchase order never count', async () => {
      const baseline = await db.countRfqsWithUnseenQuotes();
      const po = await create({ doc_type: 'po', due_date: null, title: 'הזמנה' });
      await db.markQuotesSeen(po.id); // a no-op for a purchase order, not an error
      expect(await db.countRfqsWithUnseenQuotes()).toBe(baseline);
    });

    it('counts how many recipients answered', async () => {
      const [a, b] = made.suppliers;
      const rfq = await create();
      await db.ensureRecipient(rfq.id, a);
      await db.ensureRecipient(rfq.id, b);
      expect(await db.getRfqAnswerStats(rfq.id)).toEqual({ recipients: 2, answered: 0 });
      await quote(rfq.id, a, 'portal');
      expect(await db.getRfqAnswerStats(rfq.id)).toEqual({ recipients: 2, answered: 1 });
    });

    it('notifies the creator of every submission, the tally once everyone answered, and an amendment too', async () => {
      const [a, b] = made.suppliers;
      const rfq = await create({ title: 'צביעה' });
      await db.ensureRecipient(rfq.id, a);
      await db.ensureRecipient(rfq.id, b);
      const mine = () => notices.filter((n) => n.sourceEntityId === rfq.id);

      const qa = await quote(rfq.id, a, 'portal');
      await notify.notifyQuoteSubmitted({ rfqId: rfq.id, quoteId: qa, quoteStamp: new Date().toISOString(), supplierName: 'ספק בדיקה א׳', isUpdate: false });
      expect(mine().map((n) => n.type)).toEqual(['purchasing_quote_received']);
      expect(mine()[0]).toMatchObject({ userId: admin, actionUrl: `/purchasing?tab=rfq&open=${rfq.id}` });
      expect(String(mine()[0].message)).toContain('ספק בדיקה א׳');
      expect(String(mine()[0].message)).toContain('צביעה');

      const qb = await quote(rfq.id, b, 'portal');
      await notify.notifyQuoteSubmitted({ rfqId: rfq.id, quoteId: qb, quoteStamp: new Date().toISOString(), supplierName: 'ספק בדיקה ב׳', isUpdate: false });
      expect(mine().map((n) => n.type)).toEqual(['purchasing_quote_received', 'purchasing_quote_received', 'purchasing_quotes_complete']);
      expect(String(mine()[2].message)).toContain('התקבלו 2 מתוך 2');

      await notify.notifyQuoteSubmitted({ rfqId: rfq.id, quoteId: qa, quoteStamp: new Date().toISOString(), supplierName: 'ספק בדיקה א׳', isUpdate: true });
      expect(mine()).toHaveLength(4);
      expect(mine()[3]).toMatchObject({ type: 'purchasing_quote_received', title: 'הצעת מחיר עודכנה' });
    });

    it('announces a passed due date once, with the tally, and only for a request that was sent', async () => {
      const [a, b] = made.suppliers;
      const late = await create({ due_date: '2020-01-01', title: 'באיחור' });
      await db.ensureRecipient(late.id, a);
      await db.ensureRecipient(late.id, b);
      await quote(late.id, a, 'portal');
      const unsent = await create({ due_date: '2020-01-01' });
      const open = await create({ due_date: '2099-01-01' });
      await db.ensureRecipient(open.id, a);
      const mine = (id: string) => notices.filter((n) => n.sourceEntityId === id);

      expect(await notify.notifyDueDatesPassed()).toBeGreaterThanOrEqual(1);
      expect(mine(late.id)).toHaveLength(1);
      expect(mine(late.id)[0]).toMatchObject({ type: 'purchasing_rfq_closed', userId: admin });
      expect(String(mine(late.id)[0].message)).toContain('התקבלו 1 מתוך 2');
      expect(mine(unsent.id)).toHaveLength(0);
      expect(mine(open.id)).toHaveLength(0);

      await notify.notifyDueDatesPassed();
      expect(mine(late.id)).toHaveLength(1); // never twice
    });
  });
});
