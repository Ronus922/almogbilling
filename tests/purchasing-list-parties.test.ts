import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// listDocuments gives every request its parties (supplier uuid or the typed
// supplier's manual key, plus the name) for the row's PDF / print menu, and the
// existing counts stay right. Runs only against a throwaway database
// (WA_TEST_DATABASE_URL); cleans up by the exact ids it created.
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
vi.mock('@/services/notifications', () => ({ createNotification: vi.fn(async () => undefined) }));

const db = await import('@/lib/db/purchasing');

const made = { docs: [] as string[], suppliers: [] as string[] };
let admin = '';
let before: Array<{ doc_type: string; last_number: number }> = [];

const input = (over: Partial<Parameters<typeof db.createDocument>[0]> = {}) => ({
  doc_type: 'rfq' as const, status: 'issued' as 'draft' | 'issued', doc_date: '2026-10-21', title: 'רשימת צדדים', supplier_id: null,
  supplier_name: null, supplier_phone: null, supplier_email: null, supplier_address: null, notes: '', due_date: '2099-01-01',
  vat_rate: 18, source_rfq_id: null, start_number: 5000,
  lines: [{ description: 'פריט', quantity: 1, unit_price: null }], ...over,
});

d('list parties', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    admin = await requireSeededAdmin(pool);
    before = (await pool.query(`select doc_type, last_number from public.purchasing_sequences`)).rows;
    await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq','po')`);
    const r = await pool.query<{ id: string }>(`insert into public.suppliers (display_name) values ('ספק רשימה') returning id`);
    made.suppliers.push(r.rows[0].id);
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

  it('a request lists its listed and typed suppliers, keyed by uuid / manual key, (order as created)', async () => {
    const typed = { supplier_id: null, key: 'mlist00001', name: 'מוקלד לרשימה', phone: null, email: null };
    const r = await db.createDocument(input({
      recipients: [{ supplier_id: made.suppliers[0], key: null, name: null, phone: null, email: null }, typed],
    }), admin);
    made.docs.push(r.id);
    const row = (await db.listDocuments('rfq')).find((x) => x.id === r.id)!;
    expect([...row.parties].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: made.suppliers[0], name: 'ספק רשימה' },
      { key: 'mlist00001', name: 'מוקלד לרשימה' },
    ].sort((a, b) => a.key.localeCompare(b.key)));
    expect(row.recipient_count).toBe(2);
    expect(row.quote_count).toBe(0);
    expect(row.unseen_quote_count).toBe(0);
  });

  it('a request with no suppliers and a purchase order have an empty list', async () => {
    const rfq = await db.createDocument(input({ title: 'ללא ספקים' }), admin);
    made.docs.push(rfq.id);
    const po = await db.createDocument({
      ...input({ title: 'הזמנה', supplier_id: made.suppliers[0], start_number: 6000 }), doc_type: 'po' as const,
      lines: [{ description: 'פריט', quantity: 1, unit_price: 10 }],
    }, admin);
    made.docs.push(po.id);
    expect((await db.listDocuments('rfq')).find((x) => x.id === rfq.id)!.parties).toEqual([]);
    expect((await db.listDocuments('po')).find((x) => x.id === po.id)!.parties).toEqual([]);
  });
});
