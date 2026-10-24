import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The supplier's PUBLIC link (/api/public/quote/<token>) end to end through the
// real route handlers and a real database: what a stranger holding a link can
// and cannot do —
//   • read ONLY their request, with no id that opens anything else;
//   • submit / amend a quote through the due date, a unit price on EVERY line;
//   • after the due date: read-only (PUT / upload / delete → 403 `closed`);
//   • upload only allowed types whose BYTES match, within the size / count caps;
//   • never reach another supplier's file with their own token;
//   • be rate-limited per IP.
// Throwaway database only (WA_TEST_DATABASE_URL); cleaned by recorded ids.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
const store = new Map<string, Buffer>();

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  },
}));
vi.mock('@/lib/storage/purchasingStorage', () => ({
  uploadPurchasingObject: vi.fn(async (bytes: Buffer, name: string) => {
    const key = `${crypto.randomUUID()}.${name.split('.').pop()}`;
    store.set(key, bytes);
    return { objectKey: key, sizeBytes: bytes.byteLength };
  }),
  removePurchasingObjects: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.delete(k)); }),
  readPurchasingObject: vi.fn(async (key: string) => store.get(key) ?? null),
}));
const notices: Array<Record<string, unknown>> = [];
vi.mock('@/services/notifications', () => ({
  createNotification: vi.fn(async (input: Record<string, unknown>) => { notices.push(input); }),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const db = await import('@/lib/db/purchasing');
const route = await import('@/app/api/public/quote/[token]/route');
const filesRoute = await import('@/app/api/public/quote/[token]/files/route');
const fileRoute = await import('@/app/api/public/quote/[token]/files/[fileId]/route');

const made = { docs: [] as string[], suppliers: [] as string[], buckets: [] as string[] };
let admin = '';
let before: Array<{ doc_type: string; last_number: number }> = [];
let insertedCompany = false;
let ipSeq = 0;
// Every test uses its own client IP so the per-IP limit of one never starves another.
const ip = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

const ctxOf = (token: string) => ({ params: Promise.resolve({ token }) });
type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
const req = (url: string, init: NextInit & { ip?: string } = {}) => {
  const { ip: clientIp, ...rest } = init;
  return new NextRequest(`http://localhost${url}`, {
    ...rest,
    headers: { 'x-forwarded-for': clientIp ?? ip(), ...(rest.headers as Record<string, string> | undefined) },
  });
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 1)]);
const upload = (token: string, bytes: Buffer, name: string, type = 'application/pdf') => {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return filesRoute.POST(req(`/api/public/quote/${token}/files`, { method: 'POST', body: fd }), ctxOf(token));
};
const put = (token: string, body: unknown) =>
  route.PUT(req(`/api/public/quote/${token}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), ctxOf(token));

d('public supplier link', () => {
  let rfqId = '';
  let lineIds: string[] = [];
  let tokenA = '';
  let tokenB = '';
  let supA = '';
  let supB = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    admin = await requireSeededAdmin(pool);
    before = (await pool.query(`select doc_type, last_number from public.purchasing_sequences`)).rows;
    await pool.query(`delete from public.purchasing_sequences where doc_type = 'rfq'`);
    const co = await pool.query(`insert into public.app_settings (key, value) values ('purchasing_company', '{"name":"חברת בדיקה"}') on conflict (key) do nothing`);
    insertedCompany = (co.rowCount ?? 0) > 0;
    for (const name of ['ספק ציבורי א׳', 'ספק ציבורי ב׳']) {
      const r = await pool.query<{ id: string }>(`insert into public.suppliers (display_name) values ($1) returning id`, [name]);
      made.suppliers.push(r.rows[0].id);
    }
    [supA, supB] = made.suppliers;
    const created = await db.createDocument({
      doc_type: 'rfq', status: 'issued', doc_date: '2026-10-21', title: 'בקשה ציבורית', supplier_id: null, supplier_name: 'ספק ידני', supplier_phone: null, supplier_email: null, supplier_address: null, notes: 'הערה לספק', due_date: '2099-01-01',
      vat_rate: 18, source_rfq_id: null, start_number: 900,
      lines: [{ description: 'שורה 1', quantity: 2, unit_price: null }, { description: 'שורה 2', quantity: 5, unit_price: null }],
    }, admin);
    rfqId = created.id;
    made.docs.push(rfqId);
    lineIds = (await db.listLines(rfqId)).map((l) => l.id);
    tokenA = (await db.ensureRecipient(rfqId, supA)).token;
    tokenB = (await db.ensureRecipient(rfqId, supB)).token;
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.docs.length) await pool.query(`delete from public.purchasing_documents where id = any($1::uuid[])`, [made.docs]);
    if (made.suppliers.length) await pool.query(`delete from public.suppliers where id = any($1::uuid[])`, [made.suppliers]);
    if (insertedCompany) await pool.query(`delete from public.app_settings where key = 'purchasing_company'`);
    await pool.query(`delete from public.purchasing_sequences where doc_type = 'rfq'`);
    for (const row of before) {
      await pool.query(`insert into public.purchasing_sequences (doc_type, last_number) values ($1, $2) on conflict do nothing`, [row.doc_type, row.last_number]);
    }
    await pool.end();
  });

  it('shows the supplier only their request, with no other id or token', async () => {
    const res = await route.GET(req(`/api/public/quote/${tokenA}`), ctxOf(tokenA));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('בקשה ציבורית');
    expect(text).toContain('ספק ציבורי א׳');
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain(tokenB);
    expect(text).not.toContain(supB);
    expect(text).not.toContain('ספק ציבורי ב׳');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('404s on an unknown or malformed token', async () => {
    for (const t of ['x'.repeat(43), 'short', '../../etc']) {
      const res = await route.GET(req(`/api/public/quote/${encodeURIComponent(t)}`), ctxOf(t));
      expect(res.status).toBe(404);
    }
  });

  it('requires a unit price on every line, and only this request\'s lines', async () => {
    expect((await put(tokenA, { prices: { [lineIds[0]]: 10 } })).status).toBe(400);
    expect((await put(tokenA, { prices: { [lineIds[0]]: 10, [lineIds[1]]: -1 } })).status).toBe(400);
    expect((await put(tokenA, { prices: { [lineIds[0]]: 10, [lineIds[1]]: 5, [crypto.randomUUID()]: 1 } })).status).toBe(400);
    expect((await put(tokenA, { prices: { [lineIds[0]]: 'abc', [lineIds[1]]: 5 } })).status).toBe(400);
  });

  it('accepts a quote, lets the supplier amend it, and keeps one quote per supplier', async () => {
    const first = await put(tokenA, { prices: { [lineIds[0]]: 10, [lineIds[1]]: 5 }, notes: 'ראשונה', valid_until: '2099-02-01' });
    expect(first.status).toBe(200);
    const amended = await put(tokenA, { prices: { [lineIds[0]]: 9.5, [lineIds[1]]: 5 }, notes: 'מתוקנת' });
    expect(amended.status).toBe(200);
    const body = await amended.json();
    expect(body.quote.notes).toBe('מתוקנת');
    expect(body.quote.prices[lineIds[0]]).toBe(9.5);
    expect((await db.listQuotes(rfqId)).filter((q) => q.supplier_id === supA)).toHaveLength(1);
    expect((await db.findQuote(rfqId, supB))).toBeNull();
  });

  it('checks uploads: type, real bytes, size and count — and needs a saved quote first', async () => {
    // Supplier B has no quote yet.
    expect((await upload(tokenB, PDF, 'a.pdf')).status).toBe(409);

    expect((await upload(tokenA, PDF, 'הצעה.pdf')).status).toBe(201);
    expect((await upload(tokenA, Buffer.from('MZ'.padEnd(40, 'x')), 'virus.exe', 'application/x-msdownload')).status).toBe(400);
    // An HTML page renamed .pdf: the bytes are checked, not the name.
    expect((await upload(tokenA, Buffer.from('<html><script>alert(1)</script></html>'), 'page.pdf')).status).toBe(400);
    // Declared type contradicts the extension.
    expect((await upload(tokenA, PDF, 'a.pdf', 'text/html')).status).toBe(400);
    // Over 10MB.
    expect((await upload(tokenA, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 1, 1)]), 'big.pdf')).status).toBe(400);
    // The cap is 3 files per supplier: two more fit, the fourth does not.
    expect((await upload(tokenA, PDF, 'b.pdf')).status).toBe(201);
    expect((await upload(tokenA, PDF, 'c.pdf')).status).toBe(201);
    expect((await upload(tokenA, PDF, 'd.pdf')).status).toBe(400);
  });

  it('never lets a token reach another supplier\'s file', async () => {
    const mine = (await db.findQuote(rfqId, supA))!.files[0];
    expect((await fileRoute.GET(req(`/api/public/quote/${tokenA}/files/${mine.id}`), { params: Promise.resolve({ token: tokenA, fileId: mine.id }) })).status).toBe(200);
    // B holds a valid token for the SAME request but not A's quote file.
    expect((await fileRoute.GET(req(`/api/public/quote/${tokenB}/files/${mine.id}`), { params: Promise.resolve({ token: tokenB, fileId: mine.id }) })).status).toBe(404);
    // And a random id is the same 404.
    const rnd = crypto.randomUUID();
    expect((await fileRoute.GET(req(`/api/public/quote/${tokenA}/files/${rnd}`), { params: Promise.resolve({ token: tokenA, fileId: rnd }) })).status).toBe(404);
    const dl = await fileRoute.GET(req(`/api/public/quote/${tokenA}/files/${mine.id}`), { params: Promise.resolve({ token: tokenA, fileId: mine.id }) });
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-disposition')).toContain('attachment');
  });

  it('locks everything the day after the due date, but still shows the quote', async () => {
    await pool.query(`update public.purchasing_documents set due_date = '2000-01-01' where id = $1`, [rfqId]);
    const view = await route.GET(req(`/api/public/quote/${tokenA}`), ctxOf(tokenA));
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.open).toBe(false);
    expect(body.quote.prices[lineIds[0]]).toBe(9.5);

    const closed = await put(tokenA, { prices: { [lineIds[0]]: 1, [lineIds[1]]: 1 } });
    expect(closed.status).toBe(403);
    expect((await closed.json()).error).toBe('closed');
    expect((await upload(tokenA, PDF, 'late.pdf')).status).toBe(403);
    const mine = (await db.findQuote(rfqId, supA))!.files.find((f) => f.uploaded_via === 'supplier')!;
    const del = await fileRoute.DELETE(req(`/api/public/quote/${tokenA}/files/${mine.id}`, { method: 'DELETE' }), { params: Promise.resolve({ token: tokenA, fileId: mine.id }) });
    expect(del.status).toBe(403);
    // The stored quote is untouched.
    expect((await db.findQuote(rfqId, supA))!.prices[lineIds[0]]).toBe(9.5);
  });

  it('rate-limits one IP across all its requests, unknown tokens included', async () => {
    const attacker = '203.0.113.77';
    let blocked = 0;
    for (let i = 0; i < 125; i++) {
      const t = `${'a'.repeat(40)}${String(i).padStart(3, '0')}`;
      const res = await route.GET(req(`/api/public/quote/${t}`, { ip: attacker }), ctxOf(t));
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThanOrEqual(5);
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`pq:ip:${attacker}`]);
  });

  it('tells the creator of the request when a supplier submits, and marks the link opened', async () => {
    const r = await pool.query<{ id: string }>(`insert into public.suppliers (display_name) values ('ספק ציבורי ג׳') returning id`);
    made.suppliers.push(r.rows[0].id);
    const { token } = await db.ensureRecipient(rfqId, r.rows[0].id);
    notices.length = 0;
    await pool.query(`update public.purchasing_documents set due_date = '2099-01-01' where id = $1`, [rfqId]); // an earlier test closed it
    expect((await route.GET(req(`/api/public/quote/${token}`), ctxOf(token))).status).toBe(200);
    expect((await pool.query(`select first_viewed_at from public.purchasing_rfq_recipients where token = $1`, [token])).rows[0].first_viewed_at).not.toBeNull();

    expect((await put(token, { prices: { [lineIds[0]]: 7, [lineIds[1]]: 3 } })).status).toBe(200);
    await vi.waitFor(() => expect(notices.filter((n) => n.type === 'purchasing_quote_received')).toHaveLength(1));
    expect(notices[0]).toMatchObject({ sourceEntityId: rfqId, actionUrl: `/purchasing?tab=rfq&open=${rfqId}` });
    expect(String(notices[0].message)).toContain('ספק ציבורי ג׳');
    expect(String(notices[0].message)).toContain('הגיש הצעת מחיר');

    // An amendment is announced as an update.
    await new Promise((res) => setTimeout(res, 1100));
    expect((await put(token, { prices: { [lineIds[0]]: 8, [lineIds[1]]: 3 } })).status).toBe(200);
    await vi.waitFor(() => expect(notices.filter((n) => n.type === 'purchasing_quote_received')).toHaveLength(2));
    expect(String(notices[1].message)).toContain('עדכן את הצעת המחיר');
  });
});
