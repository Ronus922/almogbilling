import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Chip orders (12/11/2026) end to end on the DB, against a throwaway database
// (WA_TEST_DATABASE_URL), never prod: the price snapshot, the match status,
// paid once, the approval writing ONLY the ticked fields to the tenants list,
// issuing chips for an order line through the EXISTING issueChipGroups (and
// its limits), ready only when every chip is linked, the reject path, and the
// OTP purpose wall between the order page and the owners portal.
// Fixtures are numeric apartments far from the seed, removed by exact ids.
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

const db = await import('@/lib/db/chipOrders');
const { issueChipGroups, deactivateChip } = await import('@/lib/db/chips');
const { issueCode, verifyCode } = await import('@/lib/db/portal/otp');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const apt = { owned: `991${tag}1`, empty: `991${tag}2`, rented: `991${tag}3` };
const PHONE = '+972539200001';
const made = { contacts: [] as string[], orders: [] as string[], chips: [] as string[], otp: [] as string[] };
let admin: { id: string; name: string };
const ids: Record<string, string> = {};

d('chip orders on the DB', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    const mk = async (n: string, owner: { name?: string; phone?: string } = {}) => {
      const r = await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, $2, $3) returning id`,
        [n, owner.name ?? null, owner.phone ?? null],
      );
      made.contacts.push(r.rows[0]!.id);
      return r.rows[0]!.id;
    };
    ids.owned = await mk(apt.owned, { name: 'בעלים רשום', phone: '0539200001' });
    ids.empty = await mk(apt.empty);
    ids.rented = await mk(apt.rented, { name: 'בעלים אחר', phone: '0539299999' });
  });

  afterAll(async () => {
    if (!pool) return;
    for (const id of made.chips) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    for (const id of made.otp) await pool.query(`delete from public.portal_otp_codes where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('prices per apartment from the settings and freezes the snapshot; owner match statuses', async () => {
    const o = await db.createChipOrder(
      {
        fullName: 'דנה כהן', phoneE164: PHONE, email: 'dana@example.test', address: 'הרצל 1 חיפה', role: 'owner', ip: null,
        lines: [
          { apartmentNumber: apt.owned, chipsCount: 3, lease: null, leaseEndDate: null },
          { apartmentNumber: apt.empty, chipsCount: 2, lease: null, leaseEndDate: null },
          { apartmentNumber: apt.rented, chipsCount: 1, lease: null, leaseEndDate: null },
        ],
      },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    ids.order = o.id;
    expect(o.total).toBe(170 + 100 + 50);
    const items = (await pool.query(
      `select apartment_number, match_status, unit_price::float8 as unit_price, threshold, price_above::float8 as price_above,
              line_total::float8 as line_total
         from public.chip_order_items where order_id = $1 order by apartment_number`, [o.id])).rows;
    const by = Object.fromEntries(items.map((i) => [i.apartment_number, i]));
    expect(by[apt.owned]).toMatchObject({ match_status: 'matched', unit_price: 50, threshold: 2, price_above: 70, line_total: 170 });
    expect(by[apt.empty].match_status).toBe('unassigned');
    expect(by[apt.rented].match_status).toBe('review');
  });

  it('an unknown apartment is refused and nothing is written', async () => {
    const before = (await pool.query(`select count(*)::int as n from public.chip_orders`)).rows[0].n;
    await expect(db.createChipOrder(
      { fullName: 'א ב', phoneE164: PHONE, email: 'a@b.test', address: 'x y', role: 'owner', ip: null,
        lines: [{ apartmentNumber: 'no-such-apt', chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    )).rejects.toThrow('apartment_not_found');
    expect((await pool.query(`select count(*)::int as n from public.chip_orders`)).rows[0].n).toBe(before);
  });

  it('pending_payment is invisible to the staff list and detail', async () => {
    expect((await db.listChipOrders()).some((x) => x.id === ids.order)).toBe(false);
    expect(await db.getChipOrderDetail(ids.order)).toBeNull();
  });

  it('marks paid exactly once', async () => {
    await db.setOrderGrowProcess(ids.order, `p${tag}`, 'tok');
    expect(await db.markChipOrderPaid(ids.order, { transactionId: 't1', transactionToken: 'tt', asmachta: 'a1' })).toBe(true);
    expect(await db.markChipOrderPaid(ids.order, { transactionId: 't2', transactionToken: 'tt', asmachta: 'a2' })).toBe(false);
    const detail = await db.getChipOrderDetail(ids.order);
    expect(detail?.status).toBe('paid');
    expect(detail?.grow_transaction_id).toBe('t1');
    expect(JSON.stringify(detail)).not.toContain('tok'); // the process token never reaches the screen
  });

  it('issuing for a line before approval is refused (existing window, new check)', async () => {
    const item = (await db.getChipOrderDetail(ids.order))!.items.find((i) => i.apartment_number === apt.owned)!;
    await expect(issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`C${tag}0`] }], order_item_id: item.id },
      admin,
    )).rejects.toThrow('order_not_approved');
  });

  it('approval writes ONLY the ticked fields, sets due_at, and moves to approved', async () => {
    const detail = (await db.getChipOrderDetail(ids.order))!;
    const empty = detail.items.find((i) => i.apartment_number === apt.empty)!;
    const rented = detail.items.find((i) => i.apartment_number === apt.rented)!;
    const res = await db.approveChipOrder(ids.order, [
      { item_id: empty.id, name: true, phone: true, email: false },
      { item_id: rented.id, name: false, phone: false, email: false },
    ], new Date('2026-11-15T08:00:00Z'));
    expect(res?.written).toHaveLength(1);
    const c = (await pool.query(`select owner_name, owner_phone, owner_email from public.contacts where id = $1`, [ids.empty])).rows[0];
    expect(c).toEqual({ owner_name: 'דנה כהן', owner_phone: '0539200001', owner_email: null });
    const r = (await pool.query(`select owner_name, owner_phone from public.contacts where id = $1`, [ids.rented])).rows[0];
    expect(r).toEqual({ owner_name: 'בעלים אחר', owner_phone: '0539299999' });
    const after = (await db.getChipOrderDetail(ids.order))!;
    expect(after.status).toBe('approved');
    expect(new Date(after.due_at!).toISOString()).toBe('2026-11-18T08:00:00.000Z');
    await expect(db.approveChipOrder(ids.order, [])).rejects.toThrow('not_paid');
  });

  it('chips issue for a line through issueChipGroups, capped at the ordered count; ready only when all are linked', async () => {
    const detail = (await db.getChipOrderDetail(ids.order))!;
    const owned = detail.items.find((i) => i.apartment_number === apt.owned)!;
    await expect(issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`A${tag}1`, `A${tag}2`, `A${tag}3`, `A${tag}4`] }], order_item_id: owned.id },
      admin,
    )).rejects.toThrow('order_item_full');
    // A line of another apartment cannot be used here.
    await expect(issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`B${tag}1`] }], order_item_id: owned.id },
      admin,
    )).rejects.toThrow('order_item_not_found');

    const issued = await issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`A${tag}1`, `A${tag}2`, `A${tag}3`] }], order_item_id: owned.id },
      admin,
    );
    made.chips.push(...issued.items.map((c) => c.id));
    expect(issued.items).toHaveLength(3);
    const ev = (await pool.query(`select event_type, new_value from public.chip_events where chip_id = $1`, [issued.items[0]!.id])).rows[0];
    expect(ev.event_type).toBe('issued');
    expect(ev.new_value.order_item_id).toBe(owned.id);

    await expect(db.markChipOrderReady(ids.order)).rejects.toThrow('chips_missing');
    for (const [aptNo, cid, n] of [[apt.empty, ids.empty, 2], [apt.rented, ids.rented, 1]] as const) {
      const item = detail.items.find((i) => i.apartment_number === aptNo)!;
      const r = await issueChipGroups(
        { contact_id: cid, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: Array.from({ length: n }, (_, k) => `${aptNo}-${k}`) }], order_item_id: item.id },
        admin,
      );
      made.chips.push(...r.items.map((c) => c.id));
    }
    expect(await db.markChipOrderReady(ids.order)).toBe(true);
    const listed = (await db.listChipOrders()).find((x) => x.id === ids.order)!;
    expect(listed).toMatchObject({ status: 'ready', chips_total: 6, chips_linked: 6 });
    await expect(db.rejectChipOrder(ids.order, 'x')).rejects.toThrow('not_rejectable');
    expect(await db.markChipOrderCollected(ids.order)).toBe(true);
  });

  it('a chip issued without an order line is untouched by all this', async () => {
    const r = await issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`Z${tag}9`] }] },
      admin,
    );
    made.chips.push(...r.items.map((c) => c.id));
    const row = (await pool.query(`select order_item_id from public.chips where id = $1`, [r.items[0]!.id])).rows[0];
    expect(row.order_item_id).toBeNull();
  });

  it('a deactivated chip no longer counts as delivered; reject waits until no active chip is left', async () => {
    const o = await db.createChipOrder(
      { fullName: 'רונית לוי', phoneE164: '+972539200003', email: 'r@example.test', address: 'כתובת 3', role: 'owner', ip: null,
        lines: [{ apartmentNumber: apt.empty, chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    await db.markChipOrderPaid(o.id, { transactionId: 't4', transactionToken: 'tt4', asmachta: null });
    const item = (await db.getChipOrderDetail(o.id))!.items[0]!;
    await db.approveChipOrder(o.id, [{ item_id: item.id, name: false, phone: false, email: false }]);
    const first = await issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'other', holder_name: 'רונית לוי', chip_type: 'physical', numbers: [`R${tag}1`] }], order_item_id: item.id },
      admin,
    );
    made.chips.push(first.items[0]!.id);
    await expect(db.rejectChipOrder(o.id, 'בדיקה')).rejects.toThrow('chips_active');
    await deactivateChip(first.items[0]!.id, { reason: 'lost' }, admin);
    const replacement = await issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'other', holder_name: 'רונית לוי', chip_type: 'physical', numbers: [`R${tag}2`] }], order_item_id: item.id },
      admin,
    );
    made.chips.push(replacement.items[0]!.id);
    expect((await db.listChipOrders()).find((x) => x.id === o.id)).toMatchObject({ chips_total: 1, chips_linked: 1 });
    await deactivateChip(replacement.items[0]!.id, { reason: 'returned' }, admin);
    await expect(db.markChipOrderReady(o.id)).rejects.toThrow('chips_missing');
    expect(await db.rejectChipOrder(o.id, 'בדיקה')).toMatchObject({ total: 50, grow_transaction_id: 't4' });
  });

  it('a tenant order: document_review, lease stored; reject keeps the reason and records the refund state', async () => {
    const o = await db.createChipOrder(
      {
        fullName: 'שוכר בדיקה', phoneE164: '+972539200002', email: 't@example.test', address: 'כתובת 2', role: 'tenant', ip: null,
        lines: [{
          apartmentNumber: apt.rented, chipsCount: 1, leaseEndDate: '2027-12-31',
          lease: { objectKey: `00000000-0000-4000-8000-${tag}000001.pdf`, fileName: 'חוזה.pdf', mime: 'application/pdf', size: 1234 },
        }],
      },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    await db.markChipOrderPaid(o.id, { transactionId: 't3', transactionToken: 'tt3', asmachta: null });
    const det = (await db.getChipOrderDetail(o.id))!;
    expect(det.items[0]).toMatchObject({ match_status: 'document_review', lease_file_name: 'חוזה.pdf', lease_end_date: '2027-12-31' });
    expect(det.items[0]!.registry.emailSupported).toBe(true);
    const rej = await db.rejectChipOrder(o.id, 'החוזה לא בתוקף');
    expect(rej).toMatchObject({ total: 50, grow_transaction_id: 't3', grow_transaction_token: 'tt3' });
    await db.setChipOrderRefund(o.id, 'manual_required', 'Grow 110: ממתין לאישור');
    const after = (await db.getChipOrderDetail(o.id))!;
    expect(after).toMatchObject({ status: 'rejected', reject_reason: 'החוזה לא בתוקף', refund_status: 'manual_required' });
    const view = await db.getChipOrderTrackView((await pool.query(`select tracking_token from public.chip_orders where id = $1`, [o.id])).rows[0].tracking_token);
    expect(view).toMatchObject({ status: 'rejected', refund_status: 'manual_required' });
    expect(Object.keys(view!)).not.toContain('full_name');
  });

  it('OTP purposes are walled off: a chip-order code never opens the portal, and vice versa', async () => {
    const p = '+972539200009';
    const chip = await issueCode(p, null, 'chip_order');
    made.otp.push(chip.id);
    expect((await verifyCode(p, chip.code, 'portal_login')).kind).toBe('none');
    const portal = await issueCode(p, null);
    made.otp.push(portal.id);
    expect((await verifyCode(p, portal.code, 'chip_order')).kind).not.toBe('ok');
    // The chip-order ceiling: 5 reserved guesses per code, even all at once —
    // after them even the right digits are refused.
    const fresh = await issueCode(p, null, 'chip_order');
    made.otp.push(fresh.id);
    const wrong = fresh.code === '000000' ? '111111' : '000000';
    const burst = await Promise.all(Array.from({ length: 12 }, () => verifyCode(p, wrong, 'chip_order', 5)));
    expect(burst.filter((r) => r.kind === 'invalid')).toHaveLength(5);
    expect(burst.filter((r) => r.kind === 'expired')).toHaveLength(7);
    expect((await verifyCode(p, fresh.code, 'chip_order', 5)).kind).toBe('expired');
    // A fresh code with the right digits passes exactly once.
    const good = await issueCode(p, null, 'chip_order');
    made.otp.push(good.id);
    const twice = await Promise.all([verifyCode(p, good.code, 'chip_order', 5), verifyCode(p, good.code, 'chip_order', 5)]);
    expect(twice.filter((r) => r.kind === 'ok')).toHaveLength(1);
    // The portal's own code was untouched by all of it.
    expect((await verifyCode(p, portal.code)).kind).toBe('ok');
  });
});
