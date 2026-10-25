import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { requireSeededAdmin } from './db-fixtures';

// POST /api/purchasing/documents/[id]/recipients against a real database: suppliers are
// added to an ISSUED, still-open request (listed and hand-typed), duplicates are ignored,
// a locked / draft / unknown request is refused, and a bad item writes nothing.
// Throwaway database only (WA_TEST_DATABASE_URL); rows are removed by the ids recorded here.
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
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/purchasingGuard', () => ({
  requirePurchasingType: vi.fn(async () => ({ id: ADMIN.id })),
}));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/purchasing/service', () => ({ quoteLink: (t: string) => `https://example.test/quote/${t}` }));

const ADMIN = { id: '' };
const db = await import('@/lib/db/purchasing');
const route = await import('@/app/api/purchasing/documents/[id]/recipients/route');

const made = { docs: [] as string[], suppliers: [] as string[] };
let before: Array<{ doc_type: string; last_number: number }> = [];

const input = (over: Partial<Parameters<typeof db.createDocument>[0]> = {}) => ({
  doc_type: 'rfq' as const, status: 'issued' as 'draft' | 'issued', doc_date: '2026-10-21', title: 'בדיקה',
  supplier_id: null, supplier_name: null, supplier_phone: null, supplier_email: null, supplier_address: null,
  notes: '', due_date: '2099-01-01', vat_rate: 18, source_rfq_id: null, start_number: 9000,
  lines: [{ description: 'פריט', quantity: 1, unit_price: null }], ...over,
});
const make = async (over: Parameters<typeof input>[0] = {}) => {
  const r = await db.createDocument(input(over), ADMIN.id);
  made.docs.push(r.id);
  return r.id;
};
const post = (id: string, recipients: unknown[]) => route.POST(
  new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ recipients }), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id }) },
);

d('purchasing add recipients', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    ADMIN.id = await requireSeededAdmin(pool);
    before = (await pool.query(`select doc_type, last_number from public.purchasing_sequences`)).rows;
    await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq','po')`);
    for (const name of ['ספק הוספה א׳', 'ספק הוספה ב׳']) {
      const r = await pool.query<{ id: string }>(`insert into public.suppliers (display_name) values ($1) returning id`, [name]);
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

  it('adds a listed and a hand-typed supplier, with a link each, and ignores duplicates', async () => {
    const id = await make();
    const [a, b] = made.suppliers;
    const res = await post(id, [
      { supplier_id: a, key: null },
      { supplier_id: null, key: 'mtyped000001', name: 'ספק שהוקלד', phone: '050-1234567', email: 'x@example.test' },
    ]);
    expect(res.status).toBe(200);
    const out = await res.json() as { recipients: Array<{ key: string; link: string }>; added_keys: string[] };
    expect(out.added_keys.sort()).toEqual([a, 'mtyped000001'].sort());
    expect(out.recipients.map((r) => r.key).sort()).toEqual([a, 'mtyped000001'].sort());
    expect(out.recipients.every((r) => r.link.startsWith('https://example.test/quote/'))).toBe(true);

    const again = await (await post(id, [{ supplier_id: a, key: null }, { supplier_id: b, key: null }])).json() as typeof out;
    expect(again.added_keys).toEqual([b]);
    expect(again.recipients).toHaveLength(3);
    // The first supplier's link did not change.
    const firstLink = out.recipients.find((r) => r.key === a)!.link;
    expect(again.recipients.find((r) => r.key === a)!.link).toBe(firstLink);
  });

  it('refuses a locked request, a draft and an unknown request', async () => {
    const locked = await make({ due_date: '2020-01-01' });
    expect((await post(locked, [{ supplier_id: made.suppliers[0], key: null }])).status).toBe(409);
    const draft = await make({ status: 'draft' });
    expect((await post(draft, [{ supplier_id: made.suppliers[0], key: null }])).status).toBe(409);
    expect((await post('22222222-2222-4222-8222-222222222222', [{ supplier_id: made.suppliers[0], key: null }])).status).toBe(404);
  });

  it('refuses a purchase order', async () => {
    const po = await make({ doc_type: 'po', supplier_id: made.suppliers[0], due_date: null, lines: [{ description: 'חומר', quantity: 1, unit_price: 5 }] });
    expect((await post(po, [{ supplier_id: made.suppliers[1], key: null }])).status).toBe(404);
  });

  it('writes nothing when one item is invalid', async () => {
    const id = await make();
    const missing = '33333333-3333-4333-8333-333333333333';
    const res = await post(id, [{ supplier_id: made.suppliers[0], key: null }, { supplier_id: missing, key: null }]);
    expect(res.status).toBe(400);
    expect(await db.listRecipients(id)).toHaveLength(0);
    expect((await post(id, [{ supplier_id: null, key: 'BAD', name: 'x' }])).status).toBe(400);
    expect(await db.listRecipients(id)).toHaveLength(0);
  });
});
