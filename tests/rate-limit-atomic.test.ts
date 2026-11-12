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

// The route under test refuses everything while the order page is closed
// (the state here: no Grow); open it, so the per-IP ceiling is what answers.
vi.mock('@/lib/chipOrders/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/chipOrders/server')>()),
  chipOrdersOpen: () => true,
}));

const { checkRateLimit } = await import('@/lib/auth/rateLimit');
const { POST: verifyChipOrderOtp } = await import('@/app/api/public/chip-order/otp/verify/route');
const { PORTAL_VERIFY_MAX_PER_IP } = await import('@/lib/constants/portal');

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
const NO_CODE_PHONE = `0539${String(Date.now()).slice(-6)}`;

/** Fills a bucket straight in the table — one hit below (or at) its limit. */
async function seed(b: string, hits: number) {
  buckets.push(b);
  await pool.query(`insert into public.auth_rate_limits (bucket) select $1 from generate_series(1, $2)`, [b, hits]);
}

const verify = (headers: Record<string, string>) =>
  verifyChipOrderOtp(new Request('http://localhost/api/public/chip-order/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    // A valid mobile that was never sent a code: once past the IP ceiling the
    // route answers 400 ("expired") — the body schema runs BEFORE the ceiling,
    // so the body must be valid for the ceiling to be reached at all.
    body: JSON.stringify({ phone: NO_CODE_PHONE, code: '123456' }),
  }));

d('checkRateLimit — atomic, and keyed by the address nginx set', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_URL, max: 25 });
    pool.on('error', () => {});
  });

  afterAll(async () => {
    if (!pool) return;
    // The route's own buckets carry the two test addresses.
    buckets.push(`chip-order:verify:ip:${ipA}`, `chip-order:verify:ip:${ipB}`);
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
    await seed(`chip-order:verify:ip:${ipA}`, PORTAL_VERIFY_MAX_PER_IP - 1);
    const last = await verify({ 'x-real-ip': ipA, 'x-forwarded-for': '1.1.1.1' });
    expect(last.status).toBe(400);
    // The same visitor now forges a fresh X-Forwarded-For (and a CF-Connecting-IP)
    // on every request — still the same bucket, still refused.
    for (const forged of ['1.1.1.2', '8.8.8.8', '10.0.0.1']) {
      const r = await verify({ 'x-real-ip': ipA, 'x-forwarded-for': forged, 'cf-connecting-ip': forged });
      expect(r.status).toBe(429);
    }
    // A different real address is not affected.
    expect((await verify({ 'x-real-ip': ipB })).status).toBe(400);
  });
});
