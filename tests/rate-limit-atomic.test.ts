import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// checkRateLimit is atomic (13/11/2026) and the IP in its keys comes from
// getClientIp — X-Real-IP only. Against a throwaway database
// (WA_TEST_DATABASE_URL), never prod. Every bucket used here carries this
// run's tag and is removed by its exact name.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
}));

// The route under test (the chip-order form's save, POST /api/public/chip-order)
// refuses everything while the order page is closed (the state here: real
// charging not armed); open it, so the per-network ceiling is what answers —
// one test closes it again.
const gate = vi.hoisted(() => ({ open: true }));
vi.mock('@/lib/chipOrders/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/chipOrders/server')>()),
  chipOrdersOpen: () => gate.open,
}));

const { checkRateLimit } = await import('@/lib/auth/rateLimit');
const { POST: saveChipOrder } = await import('@/app/api/public/chip-order/route');
/** The route's ceiling of saves per network per hour (chip-order:save:ip). */
const SAVE_MAX_PER_IP = 300;
/** …and of saves that carry a new lease file (a body over 512KB — chip-order:upload:ip). */
const UPLOAD_MAX_PER_IP = 20;

const tag = `t${Date.now()}`;
const buckets: string[] = [];
const bucket = (name: string) => {
  const b = `test:${tag}:${name}`;
  buckets.push(b);
  return b;
};
/** TEST-NET addresses unique to this run (RFC 5737). */
const ipA = `203.0.113.${(Date.now() % 200) + 1}`;
const ipB = `198.51.100.${(Date.now() % 200) + 1}`;
const ipC = `192.0.2.${(Date.now() % 200) + 1}`;

/** Fills a bucket straight in the table — one hit below (or at) its limit. */
async function seed(b: string, hits: number) {
  buckets.push(b);
  await pool.query(`insert into public.auth_rate_limits (bucket) select $1 from generate_series(1, $2)`, [b, hits]);
}

const save = (headers: Record<string, string>) =>
  saveChipOrder(new Request('http://localhost/api/public/chip-order', {
    method: 'POST',
    // Not a form: once past the per-network ceiling the route answers 400
    // (invalid_form_data) and writes nothing — the ceiling is counted BEFORE
    // the body is read, so the body never matters for reaching it.
    headers: { 'content-type': 'application/json', 'content-length': '2', ...headers },
    body: '{}',
  }));

/** A save whose body records whether anything read it (highWaterMark 0:
 *  nothing is pulled from the stream until a reader asks for it). */
function watchedSave(headers: Record<string, string>) {
  const seen = { pulled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled = true;
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const res = saveChipOrder(new Request('http://localhost/api/public/chip-order', {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', ...headers }, body: stream, duplex: 'half',
  } as RequestInit));
  return { seen, res };
}

d('checkRateLimit — atomic, and keyed by the address nginx set', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_URL, max: 25 });
    pool.on('error', () => {});
  });

  afterAll(async () => {
    if (!pool) return;
    // The route's own buckets carry the test addresses.
    buckets.push(
      `chip-order:save:ip:${ipA}`, `chip-order:save:ip:${ipB}`, `chip-order:save:ip:${ipC}`,
      `chip-order:upload:ip:${ipA}`, `chip-order:upload:ip:${ipB}`, `chip-order:upload:ip:${ipC}`,
    );
    await pool.query(`delete from public.auth_rate_limits where bucket = any($1::text[])`, [buckets]);
    await pool.end();
  });

  it('20 parallel calls against a limit of 5 — exactly 5 pass, 5 hits recorded', async () => {
    const b = bucket('burst');
    const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(b, { max: 5, windowSec: 600 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed).every((r) => r.retryAfterSec === 600)).toBe(true);
    const n = await pool.query<{ n: number }>(`select count(*)::int as n from public.auth_rate_limits where bucket = $1`, [b]);
    expect(n.rows[0]!.n).toBe(5);
  });

  it('different buckets (addresses) are counted separately', async () => {
    const a = bucket('ip:a');
    const c = bucket('ip:c');
    expect((await checkRateLimit(a, { max: 1, windowSec: 600 })).allowed).toBe(true);
    expect((await checkRateLimit(a, { max: 1, windowSec: 600 })).allowed).toBe(false);
    expect((await checkRateLimit(c, { max: 1, windowSec: 600 })).allowed).toBe(true);
  });

  it('the window slides: hits older than it no longer count', async () => {
    const b = bucket('slide');
    await pool.query(
      `insert into public.auth_rate_limits (bucket, hit_at) select $1, now() - interval '11 minutes' from generate_series(1, 5)`,
      [b],
    );
    expect((await checkRateLimit(b, { max: 5, windowSec: 600 })).allowed).toBe(true);
  });

  it('a route: a forged X-Forwarded-For cannot escape the per-IP ceiling; another real address is counted on its own', async () => {
    // Address A one hit below its ceiling.
    await seed(`chip-order:save:ip:${ipA}`, SAVE_MAX_PER_IP - 1);
    const last = await save({ 'x-real-ip': ipA, 'x-forwarded-for': '1.1.1.1' });
    expect(last.status).toBe(400);
    // The same visitor now forges a fresh X-Forwarded-For (and a CF-Connecting-IP)
    // on every request — still the same bucket, still refused.
    for (const forged of ['1.1.1.2', '8.8.8.8', '10.0.0.1']) {
      const r = await save({ 'x-real-ip': ipA, 'x-forwarded-for': forged, 'cf-connecting-ip': forged });
      expect(r.status).toBe(429);
    }
    const hits = await pool.query<{ n: number }>(`select count(*)::int as n from public.auth_rate_limits where bucket = $1`, [`chip-order:save:ip:${ipA}`]);
    expect(hits.rows[0]!.n).toBe(SAVE_MAX_PER_IP);
    // A different real address is not affected.
    expect((await save({ 'x-real-ip': ipB })).status).toBe(400);
  });

  // Regression (review, 26/11): formData() buffers the whole body (up to 41MB)
  // — every refusal an anonymous caller can reach must come before it.
  it('the route refuses BEFORE a byte of the body is read: a closed page, a body too large or of unknown size, the network\'s ceiling of saves — and of file-carrying saves', async () => {
    // The page closed (no test link) → 403.
    gate.open = false;
    try {
      const w = watchedSave({ 'x-real-ip': ipC, 'content-length': '2' });
      expect((await w.res).status).toBe(403);
      expect(w.seen.pulled).toBe(false);
    } finally {
      gate.open = true;
    }
    // Larger than the leases may add up to, or of unknown size → 413.
    for (const length of [String(41 * 1024 * 1024 + 1), null]) {
      const w = watchedSave({ 'x-real-ip': ipC, ...(length ? { 'content-length': length } : {}) });
      expect((await w.res).status, String(length)).toBe(413);
      expect(w.seen.pulled).toBe(false);
    }
    // A file-carrying save (over 512KB) once the network's file ceiling is reached → 429.
    await seed(`chip-order:upload:ip:${ipC}`, UPLOAD_MAX_PER_IP);
    const big = watchedSave({ 'x-real-ip': ipC, 'content-length': String(2 * 1024 * 1024) });
    expect((await big.res).status).toBe(429);
    expect(big.seen.pulled).toBe(false);
    // A small save of that network is not a file-carrying one: it gets past the gates (400 — not a form).
    expect((await save({ 'x-real-ip': ipC })).status).toBe(400);
    // The network's ceiling of saves reached → 429, for a small body too.
    await seed(`chip-order:save:ip:${ipC}`, SAVE_MAX_PER_IP);
    const small = watchedSave({ 'x-real-ip': ipC, 'content-length': '2' });
    expect((await small.res).status).toBe(429);
    expect(small.seen.pulled).toBe(false);
  });
});
