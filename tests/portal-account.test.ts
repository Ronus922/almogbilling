import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// "החשבון שלי", the month-end bank balance behind its switch, and the OTP /
// lockout / rate-limit layers of the owners portal (28/09/2026), against a
// throwaway database (WA_TEST_DATABASE_URL) — never prod. Fixtures are made
// here and removed by their exact ids (iron rule 12).
//
//   • getPortalMyAccount takes the SESSION only: the apartments come from the
//     roster of its phone, the SELECT names its columns, nothing else of the
//     debtors row leaves (legal status, notes, phones, other owners' names);
//   • a phone with two apartments gets two accounts; a missing debtors row is
//     0 debt; an archived row is shown like any other (decision 28/09/2026),
//     with its exact figures and no status of any kind;
//   • getAdminPreviewAccount is a separate entry point for ONE apartment;
//   • the bank balance reaches the resident data only while the switch is on;
//   • a code is consumed once, refused when expired, and never crosses phones;
//     lockouts escalate 30m → 2h → 24h; the rate-limit buckets count.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

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

const { getAdminPreviewAccount, getLastSyncAt, getPortalMyAccount } = await import('@/lib/db/portal/account');
const { getResidentMonthData, getResidentOverview } = await import('@/lib/db/finance/portal');
const { listPublishedMonthBalances, setMonthBankBalance, setMonthPublished, getMonthStatus } = await import('@/lib/db/finance/month-status');
const { getFinanceSettings, updateFinanceSettings } = await import('@/lib/db/finance/settings');
const { issueCode, verifyCode, resendCooldownRemaining } = await import('@/lib/db/portal/otp');
const { activeLockout, createLockout } = await import('@/lib/db/portal/lockouts');
const { checkRateLimit, clearRateLimit } = await import('@/lib/auth/rateLimit');
const { createEntry } = await import('@/lib/db/finance/entries');
const { currentMonthKey, monthKeyParts, periodMonthOf, shiftMonthKey } = await import('@/lib/finance/period');

const tag = `pa-${Date.now()}`;
const apt = { a: `${tag}-A`, b: `${tag}-B`, c: `${tag}-C`, d: `${tag}-D`, none: `${tag}-N` };
const phone = { a1: '+972521000001', a2: '+972521000002', b: '+972521000003', ab: '+972521000004', d: '+972521000005', none: '+972521000006', otp: '+972521000007', otp2: '+972521000008' };
const made = {
  contacts: [] as string[], debtors: [] as string[], roster: [] as string[], categories: [] as string[], entries: [] as string[],
  months: [] as Array<{ year: number; month: number }>, otp: [] as string[], lockouts: [] as string[], buckets: [] as string[],
};
let actorId = '';
let settingsBefore = { docs: false, bank: false };
let monthsBefore = new Map<string, { published: boolean; bank_balance: number | null }>();
const cur = currentMonthKey();
const prev = shiftMonthKey(cur, -1);
const prev2 = shiftMonthKey(cur, -2);

async function contact(n: string) {
  const r = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [n]);
  made.contacts.push(r.rows[0]!.id);
}
async function debtor(n: string, v: Partial<{ total: number; mgmt: number; hot: number; monthly: string | null; details: string | null; archived: boolean }>) {
  const r = await pool.query<{ id: string }>(
    `insert into public.debtors (apartment_number, owner_name, phone_owner, email_owner, total_debt, management_fees, hot_water_debt, monthly_debt, details, is_archived, notes, next_action_description, legal_status_updated_by_name)
     values ($1, 'CANARY-OWNER', '050-9999999', 'canary@example.com', $2, $3, $4, $5, $6, $7, 'CANARY-NOTE', 'CANARY-ACTION', 'CANARY-LEGAL') returning id`,
    [n, v.total ?? 0, v.mgmt ?? 0, v.hot ?? 0, v.monthly ?? null, v.details ?? null, v.archived ?? false],
  );
  made.debtors.push(r.rows[0]!.id);
}
async function roster(n: string, p: string, name: string | null, active = true) {
  const r = await pool.query<{ id: string }>(
    `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164, is_active) values ($1, $2, $3, $4) returning id`,
    [n, name, p, active],
  );
  made.roster.push(r.rows[0]!.id);
}
async function rememberMonth(key: string) {
  const { year, month } = monthKeyParts(key);
  const row = await pool.query<{ published: boolean; bank_balance: number | null }>(
    `select published, bank_balance::float8 as bank_balance from public.finance_month_status where year = $1 and month = $2`, [year, month],
  );
  if (row.rowCount === 0) made.months.push({ year, month });
  else monthsBefore.set(key, row.rows[0]!);
}

d('owners portal — my account, bank balance, one-time codes', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const admin = await pool.query<{ id: string }>(`select id from public.users where username = 'e2e-admin'`);
    actorId = admin.rows[0]!.id;
    const s = await getFinanceSettings();
    settingsBefore = { docs: s.show_documents_to_residents, bank: s.show_bank_balance_to_residents };
    monthsBefore = new Map();
    for (const k of [cur, prev, prev2]) await rememberMonth(k);

    for (const n of Object.values(apt)) await contact(n);
    await debtor(apt.a, { total: 1240, mgmt: 840, hot: 400, monthly: '3/26', details: 'מים חמים 01-03/26' });
    await debtor(apt.b, { total: 300, mgmt: 0, hot: 300, monthly: ' ' });
    // settled, but the row still carries the text an earlier report brought
    await debtor(apt.c, { total: 0, monthly: '1/26 - 9/26', details: 'מים חמים 05-06/25' });
    await debtor(apt.d, { total: 999.5, mgmt: 999.5, archived: true, monthly: '9/26', details: 'מים חמים 07-09/26' });
    await roster(apt.a, phone.a1, 'דנה');
    await roster(apt.a, phone.a2, 'יוסי');
    await roster(apt.b, phone.b, 'בני');
    await roster(apt.a, phone.ab, 'רב-דירתי');
    await roster(apt.b, phone.ab, 'רב-דירתי');
    await roster(apt.d, phone.d, 'דוד');
    await roster(apt.none, phone.none, 'בלי חייב');
    await roster(apt.c, phone.otp, 'גלית');
  });

  afterAll(async () => {
    for (const id of made.entries) await pool.query(`delete from public.fin_entries where id = $1`, [id]);
    for (const id of made.categories) await pool.query(`delete from public.fin_categories where id = $1`, [id]);
    for (const id of made.roster) await pool.query(`delete from public.apartment_owner_phones where id = $1`, [id]);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.otp) await pool.query(`delete from public.portal_otp_codes where id = $1`, [id]);
    for (const id of made.lockouts) await pool.query(`delete from public.portal_lockouts where id = $1`, [id]);
    for (const b of made.buckets) await clearRateLimit(b);
    for (const m of made.months) await pool.query(`delete from public.finance_month_status where year = $1 and month = $2`, [m.year, m.month]);
    for (const [k, v] of monthsBefore) {
      const { year, month } = monthKeyParts(k);
      await pool.query(`update public.finance_month_status set published = $3, bank_balance = $4 where year = $1 and month = $2`, [year, month, v.published, v.bank_balance]);
    }
    await updateFinanceSettings({ show_documents_to_residents: settingsBefore.docs, show_bank_balance_to_residents: settingsBefore.bank }, actorId);
    await pool.end();
  });

  it('the session alone decides the apartment; the row is the named columns and nothing else', async () => {
    const acc = await getPortalMyAccount({ id: 's', phoneE164: phone.a1 });
    expect(acc).toHaveLength(1);
    expect(acc[0]).toEqual({
      apartment_number: apt.a, owner_display_name: 'דנה',
      total_debt: 1240, management_fees: 840, hot_water_debt: 400, monthly_debt: '3/26', details: 'מים חמים 01-03/26',
      synced_at: await getLastSyncAt(),
    });
    expect(JSON.stringify(acc)).not.toMatch(/CANARY|050-9999999|canary@example|archived|legal|status|notes/);
    // the second owner of the same apartment gets the same figures, under their own name
    const acc2 = await getPortalMyAccount({ id: 's', phoneE164: phone.a2 });
    expect(acc2[0]).toMatchObject({ apartment_number: apt.a, owner_display_name: 'יוסי', total_debt: 1240 });
  });

  it('a phone with two apartments gets two accounts, in apartment order', async () => {
    const acc = await getPortalMyAccount({ id: 's', phoneE164: phone.ab });
    expect(acc.map((a) => a.apartment_number)).toEqual([apt.a, apt.b]);
    expect(acc[1]).toMatchObject({ total_debt: 300, hot_water_debt: 300, monthly_debt: null });
  });

  it('no debtors row → 0; an archived row → its exact figures like any other, no status; a phone that owns nothing → []', async () => {
    const none = await getPortalMyAccount({ id: 's', phoneE164: phone.none });
    expect(none[0]).toEqual({ apartment_number: apt.none, owner_display_name: 'בלי חייב', total_debt: 0, management_fees: 0, hot_water_debt: 0, monthly_debt: null, details: null, synced_at: await getLastSyncAt() });
    const archived = await getPortalMyAccount({ id: 's', phoneE164: phone.d });
    expect(archived).toHaveLength(1);
    expect(archived[0]).toEqual({
      apartment_number: apt.d, owner_display_name: 'דוד',
      total_debt: 999.5, management_fees: 999.5, hot_water_debt: 0, monthly_debt: '9/26', details: 'מים חמים 07-09/26',
      synced_at: await getLastSyncAt(),
    });
    expect(JSON.stringify(archived)).not.toMatch(/CANARY|archived|legal|status|notes|050-9999999/);
    // the admin preview of the same apartment: the same figures, no mark
    expect(await getAdminPreviewAccount(apt.d)).toMatchObject({ total_debt: 999.5, management_fees: 999.5, details: 'מים חמים 07-09/26' });
    expect(JSON.stringify(await getAdminPreviewAccount(apt.d))).not.toMatch(/archived|legal|status|notes/);
    expect(await getPortalMyAccount({ id: 's', phoneE164: '+972529999999' })).toEqual([]);
  });

  it('a settled apartment shows no debt text, even when the row still holds it (29/09/2026)', async () => {
    const settled = await getPortalMyAccount({ id: 's', phoneE164: phone.otp });
    expect(settled[0]).toMatchObject({ apartment_number: apt.c, total_debt: 0, monthly_debt: null, details: null });
    expect(JSON.stringify(settled)).not.toContain('מים חמים');
    // the admin preview of the same apartment hides it too — one chokepoint
    expect(await getAdminPreviewAccount(apt.c)).toMatchObject({ total_debt: 0, monthly_debt: null, details: null });
  });

  it('the admin preview reads one apartment by number, and null for an unknown one', async () => {
    const b = await getAdminPreviewAccount(apt.b);
    expect(b).toMatchObject({ apartment_number: apt.b, owner_display_name: 'CANARY-OWNER', total_debt: 300 });
    expect(await getAdminPreviewAccount(`${tag}-NOPE`)).toBeNull();
  });

  it('the bank balance reaches residents only while the switch is on, newest published month first, with the previous one', async () => {
    const catInc = await pool.query<{ id: string }>(`insert into public.fin_categories (kind, name, section, created_by) values ('income', $1, 'operating', $2) returning id`, [`${tag}-inc`, actorId]);
    made.categories.push(catInc.rows[0]!.id);
    for (const m of [prev2, prev, cur]) {
      const e = await createEntry({ kind: 'income', category_id: catInc.rows[0]!.id, period_month: periodMonthOf(m), amount: 100, description: `${tag} ${m}`, internal_note: '', supplier_id: null, supplier_name: '', invoice_number: '', payment_date: null }, actorId);
      made.entries.push(e.id);
    }
    const p2 = monthKeyParts(prev2); const p1 = monthKeyParts(prev); const c = monthKeyParts(cur);
    await setMonthPublished(p2.year, p2.month, true, actorId);
    await setMonthPublished(p1.year, p1.month, true, actorId);
    await setMonthPublished(c.year, c.month, false, actorId);
    await setMonthBankBalance(p2.year, p2.month, 46180, actorId);
    await setMonthBankBalance(p1.year, p1.month, 48320, actorId);
    await setMonthBankBalance(c.year, c.month, 7654321, actorId);
    expect((await getMonthStatus(p1.year, p1.month)).bank_balance).toBe(48320);
    const balances = await listPublishedMonthBalances();
    expect(balances.find((b) => b.year === c.year && b.month === c.month)).toBeUndefined();

    await updateFinanceSettings({ show_bank_balance_to_residents: false }, actorId);
    const off = await getResidentOverview(12);
    expect(off?.bank_balance).toBeUndefined();
    expect((await getResidentMonthData(p1.year, p1.month))?.bank_balance).toBeUndefined();

    await updateFinanceSettings({ show_bank_balance_to_residents: true }, actorId);
    const on = await getResidentOverview(12);
    expect(on?.bank_balance).toEqual({ month: prev, value: 48320, previous: { month: prev2, value: 46180 } });
    expect((await getResidentMonthData(p1.year, p1.month))?.bank_balance).toBe(48320);
    // the hidden month's balance is nowhere, switch or no switch
    expect(JSON.stringify(on)).not.toContain('7654321');
    // clearing the previous month's value drops the delta line
    await setMonthBankBalance(p2.year, p2.month, null, actorId);
    expect((await getResidentOverview(12))?.bank_balance).toEqual({ month: prev, value: 48320, previous: null });
  });

  it('a code opens once, is refused after use and past its TTL, and never crosses phones', async () => {
    const issued = await issueCode(phone.otp, '1.2.3.4');
    made.otp.push(issued.id);
    expect(await resendCooldownRemaining(phone.otp)).toBeGreaterThan(0);
    expect(await verifyCode(phone.otp2, issued.code)).toEqual({ kind: 'none' });
    const wrong = await verifyCode(phone.otp, issued.code === '000000' ? '111111' : '000000');
    expect(wrong).toEqual({ kind: 'invalid', attempts: 1 });
    expect(await verifyCode(phone.otp, issued.code)).toEqual({ kind: 'ok' });
    expect(await verifyCode(phone.otp, issued.code)).toEqual({ kind: 'expired' });
    const stale = await issueCode(phone.otp2, null);
    made.otp.push(stale.id);
    await pool.query(`update public.portal_otp_codes set expires_at = now() - interval '1 second' where id = $1`, [stale.id]);
    expect(await verifyCode(phone.otp2, stale.code)).toEqual({ kind: 'expired' });
  });

  it('lockouts escalate 30 → 120 → 1440 minutes and stay at the top; the rate-limit bucket counts', async () => {
    const p = '+972521000009';
    const minutes = (until: string) => Math.round((new Date(until).getTime() - Date.now()) / 60_000);
    const l1 = await createLockout(p, 'too_many_invalid_codes'); made.lockouts.push(l1.lockout.id);
    expect(l1.lockout.tier).toBe(1); expect(minutes(l1.lockout.locked_until)).toBe(30);
    expect((await activeLockout(p))?.id).toBe(l1.lockout.id);
    const l2 = await createLockout(p, 'too_many_code_requests'); made.lockouts.push(l2.lockout.id);
    expect(l2.lockout.tier).toBe(2); expect(minutes(l2.lockout.locked_until)).toBe(120);
    const l3 = await createLockout(p, 'too_many_invalid_codes'); made.lockouts.push(l3.lockout.id);
    expect(l3.lockout.tier).toBe(3); expect(minutes(l3.lockout.locked_until)).toBe(1440); expect(l3.countInWindow).toBe(3);
    const l4 = await createLockout(p, 'too_many_invalid_codes'); made.lockouts.push(l4.lockout.id);
    expect(l4.lockout.tier).toBe(3);
    const bucket = `portal:otp:test:${tag}`; made.buckets.push(bucket);
    for (let i = 0; i < 3; i += 1) expect((await checkRateLimit(bucket, { max: 3, windowSec: 60 })).allowed).toBe(true);
    expect((await checkRateLimit(bucket, { max: 3, windowSec: 60 })).allowed).toBe(false);
  });
});
