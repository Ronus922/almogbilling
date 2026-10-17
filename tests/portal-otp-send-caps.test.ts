import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// "הגנת שליחות" (round 4, 17/10/2026) — the cumulative per-phone hour/day send
// ceilings and the raised per-IP ceiling on POST /api/portal/otp/request,
// against a throwaway database (WA_TEST_DATABASE_URL), never prod. The route
// runs for real (real DB, real checkRateLimit, real roster lookup); only the
// actual WhatsApp/SMS delivery and the manager alert are mocked. Fixtures are
// made here and removed by their exact ids (iron rule 12) — numeric apartment
// numbers, far from the seed and from tests/portal-account.test.ts's own
// lettered fixtures (see billing-full-gate-recipe's "lettered apartment
// fixtures collide" trap).
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
vi.mock('@/lib/portal/send', () => ({
  sendPortalCode: vi.fn(async () => ({ ok: true })),
  alertManagerAboutLockout: vi.fn(async () => undefined),
}));

const { POST } = await import('@/app/api/portal/otp/request/route');
const { clearRateLimit } = await import('@/lib/auth/rateLimit');
const {
  PORTAL_OTP_MAX_PER_HOUR, PORTAL_OTP_MAX_PER_DAY, PORTAL_OTP_MAX_PER_IP,
  PORTAL_OTP_TOO_MANY_MESSAGE,
} = await import('@/lib/constants/portal');

const tag = String(Date.now()).slice(-6);
const apt = { a: `990${tag}1`, b: `990${tag}2`, c: `990${tag}3`, d: `990${tag}4`, e: `990${tag}5` };
const phone = {
  a: '+972539100001', b: '+972539100002', c: '+972539100003', d: '+972539100004', e: '+972539100005',
};
const made = { contacts: [] as string[], roster: [] as string[], buckets: [] as string[] };

async function contact(n: string) {
  const r = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [n]);
  made.contacts.push(r.rows[0]!.id);
}
async function roster(n: string, p: string) {
  const r = await pool.query<{ id: string }>(
    `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164, is_active) values ($1, $2, $3, true) returning id`,
    [n, 'דייר בדיקה', p],
  );
  made.roster.push(r.rows[0]!.id);
}
/** Fills a bucket directly, bypassing the route — the fast way to put a
 *  ceiling right at (or one below) its limit before a single real call. */
async function seedBucket(bucket: string, hits: number) {
  made.buckets.push(bucket);
  if (hits <= 0) return;
  await pool.query(
    `insert into public.auth_rate_limits (bucket, hit_at) select $1, now() from generate_series(1, $2)`,
    [bucket, hits],
  );
}
/** Defeats the 45-second resend cooldown for a phone that just got a REAL
 *  code issued, so the next real call can reach the check under test instead
 *  of being stopped by the cooldown first — the same backdating technique
 *  tests/portal-account.test.ts uses for an expired code. */
async function clearCooldown(phoneE164: string) {
  await pool.query(
    `update public.portal_otp_codes set created_at = now() - interval '1 hour'
      where phone_e164 = $1 and created_at = (
        select max(created_at) from public.portal_otp_codes where phone_e164 = $1
      )`,
    [phoneE164],
  );
}
function req(body: Record<string, unknown>, ip: string) {
  return new Request('http://x/api/portal/otp/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

d('owners portal — OTP send protection (cumulative hour/day ceilings, raised IP ceiling)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    for (const n of Object.values(apt)) await contact(n);
    await roster(apt.a, phone.a);
    await roster(apt.b, phone.b);
    await roster(apt.c, phone.c);
    await roster(apt.d, phone.d);
    await roster(apt.e, phone.e);
  });

  afterAll(async () => {
    for (const id of made.roster) await pool.query(`delete from public.apartment_owner_phones where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.query(`delete from public.portal_otp_codes where phone_e164 = any($1)`, [Object.values(phone)]);
    for (const b of made.buckets) await clearRateLimit(b);
    await pool.end();
  });

  it('the resend cooldown is enforced by the ROUTE itself, not only the UI', async () => {
    const res1 = await POST(req({ phone: phone.a }, '203.0.113.11'));
    expect((await res1.json()).sent).toBe(true);

    const res2 = await POST(req({ phone: phone.a }, '203.0.113.11'));
    expect(res2.status).toBe(429);
    const body2 = await res2.json();
    expect(body2.ok).toBe(false);
    expect(typeof body2.retryAfterSec).toBe('number');
    expect(body2.retryAfterSec).toBeGreaterThan(0);
    expect(body2.message).toContain('נסה שוב בעוד');
  });

  it('the hourly ceiling (5) rejects the 6th send with the generic message, before the daily one', async () => {
    const bucket = `portal:otp:phone:hour:${phone.b}`;
    await seedBucket(bucket, PORTAL_OTP_MAX_PER_HOUR);
    const res = await POST(req({ phone: phone.b }, '203.0.113.12'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.message).toBe(PORTAL_OTP_TOO_MANY_MESSAGE);
    // never a lockout, and never a hint about registration either way
    expect(body.locked).not.toBe(true);
    expect(body.notRegistered).toBeUndefined();
  });

  it('the hourly ceiling is SHARED between SMS and the WhatsApp fallback — using one does not free the other', async () => {
    const bucket = `portal:otp:phone:hour:${phone.c}`;
    await seedBucket(bucket, PORTAL_OTP_MAX_PER_HOUR - 1);

    // the 5th send, over WhatsApp, still gets through — the bucket is now full
    const sent = await POST(req({ phone: phone.c, channel: 'whatsapp' }, '203.0.113.13'));
    expect((await sent.json()).sent).toBe(true);

    await clearCooldown(phone.c);

    // falling back to SMS buys nothing: the shared bucket is already spent
    const capped = await POST(req({ phone: phone.c, channel: 'sms' }, '203.0.113.13'));
    expect(capped.status).toBe(429);
    expect((await capped.json()).message).toBe(PORTAL_OTP_TOO_MANY_MESSAGE);
  });

  it('the daily ceiling (10) rejects the 11th send even with the hourly one wide open', async () => {
    await seedBucket(`portal:otp:phone:hour:${phone.d}`, 0);
    await seedBucket(`portal:otp:phone:day:${phone.d}`, PORTAL_OTP_MAX_PER_DAY);
    const res = await POST(req({ phone: phone.d }, '203.0.113.14'));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe(PORTAL_OTP_TOO_MANY_MESSAGE);
  });

  it('the per-IP ceiling is 30, not 20 — the 30th from one IP still gets through', async () => {
    const ip = '203.0.113.15';
    await seedBucket(`portal:otp:ip:${ip}`, PORTAL_OTP_MAX_PER_IP - 1);
    const res = await POST(req({ phone: phone.e }, ip));
    expect((await res.json()).sent).toBe(true);
  });

  it('…but the 31st from that same IP does not', async () => {
    const ip = '203.0.113.16';
    await seedBucket(`portal:otp:ip:${ip}`, PORTAL_OTP_MAX_PER_IP);
    const res = await POST(req({ phone: phone.a }, ip));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain('יותר מדי בקשות מהמכשיר הזה');
  });
});
