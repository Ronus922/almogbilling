import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// The one-time-code verify shared by the owners portal and the chip-order page
// (13/11/2026): every guess reserves its attempt in ONE atomic UPDATE before the
// compare, so a burst of parallel guesses checks at most PORTAL_OTP_MAX_ATTEMPTS
// values per code — the portal used to compare first and count after. Runs
// against a throwaway database (WA_TEST_DATABASE_URL), never prod; every code
// row it creates is removed by its exact id.
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

const { issueCode, verifyCode } = await import('@/lib/db/portal/otp');
const { PORTAL_OTP_MAX_ATTEMPTS } = await import('@/lib/constants/portal');

const tag = String(Date.now()).slice(-7);
const made: string[] = [];

d('one-time code verify — atomic attempts (portal + chip orders)', () => {
  beforeAll(() => {
    // 25 connections: the 20 guesses really run at the same time.
    pool = new Pool({ connectionString: TEST_URL, max: 25 });
    pool.on('error', () => {});
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.length) await pool.query(`delete from public.portal_otp_codes where id = any($1::uuid[])`, [made]);
    await pool.end();
  });

  it('portal: 20 parallel wrong guesses — exactly 5 are compared, the code is burned', async () => {
    const phone = `+97252${tag.padStart(7, '0')}`;
    const issued = await issueCode(phone, null);
    made.push(issued.id);
    const wrong = issued.code === '000000' ? '111111' : '000000';

    const burst = await Promise.all(Array.from({ length: 20 }, () => verifyCode(phone, wrong)));
    const checked = burst.filter((r) => r.kind === 'invalid');
    expect(checked).toHaveLength(PORTAL_OTP_MAX_ATTEMPTS);
    expect(burst.filter((r) => r.kind === 'expired')).toHaveLength(20 - PORTAL_OTP_MAX_ATTEMPTS);
    // Each compared guess got its own attempt number: 1..5, no two alike — the
    // route turns exactly one of them (the 5th) into a lockout.
    const attempts = checked.map((r) => (r.kind === 'invalid' ? r.attempts : -1)).sort((a, b) => a - b);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);

    const row = await pool.query<{ attempts: number; consumed_at: string | null }>(
      `select attempts, consumed_at from public.portal_otp_codes where id = $1`,
      [issued.id],
    );
    expect(row.rows[0]).toMatchObject({ attempts: PORTAL_OTP_MAX_ATTEMPTS, consumed_at: null });
    // Burned: after 5 wrong guesses even the right digits are refused.
    expect(await verifyCode(phone, issued.code)).toEqual({ kind: 'expired' });
  });

  it('portal: a correct guess still works below the ceiling, and opens only once', async () => {
    const phone = `+97253${tag.padStart(7, '0')}`;
    const issued = await issueCode(phone, null);
    made.push(issued.id);
    const wrong = issued.code === '000000' ? '111111' : '000000';
    expect(await verifyCode(phone, wrong)).toEqual({ kind: 'invalid', attempts: 1 });
    const twice = await Promise.all([verifyCode(phone, issued.code), verifyCode(phone, issued.code)]);
    expect(twice.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(twice.filter((r) => r.kind === 'expired')).toHaveLength(1);
  });

  it('the purposes stay apart: a burst on the chip-order code leaves the portal code untouched', async () => {
    const phone = `+97254${tag.padStart(7, '0')}`;
    const portal = await issueCode(phone, null, 'portal_login');
    made.push(portal.id);
    const chip = await issueCode(phone, null, 'chip_order');
    made.push(chip.id);
    const wrong = chip.code === '000000' ? '111111' : '000000';
    const burst = await Promise.all(Array.from({ length: 20 }, () => verifyCode(phone, wrong, 'chip_order')));
    expect(burst.filter((r) => r.kind === 'invalid')).toHaveLength(PORTAL_OTP_MAX_ATTEMPTS);
    expect(await verifyCode(phone, portal.code)).toEqual({ kind: 'ok' });
  });
});
