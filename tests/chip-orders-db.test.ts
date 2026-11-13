import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Chip orders (12/11/2026) end to end on the DB, against a throwaway database
// (WA_TEST_DATABASE_URL), never prod: the price snapshot, the match status,
// paid once with the due date from the payment, no approval step (13/11/2026)
// — a paid order is assigned at once through the EXISTING issueChipGroups,
// linked per group, more than ordered allowed — one Orders-tab row per
// apartment, the issue window's context (same phone, open orders only),
// "עדכן בכרטיס הדייר" as the ONLY write to the tenants list, ready only when
// every chip is linked, the reject path, and the OTP purpose wall between the
// order page and the owners portal.
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

  const itemOf = async (orderId: string, aptNo: string) =>
    (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1 and apartment_number = $2`, [orderId, aptNo])).rows[0]!.id;
  const rowsOf = async (orderId: string) => (await db.listOpenChipOrderRows()).filter((r) => r.order_id === orderId);
  const contactRow = async (id: string) =>
    (await pool.query(`select owner_name, owner_phone, owner_email, tenant_name, tenant_phone, tenant_email from public.contacts where id = $1`, [id])).rows[0];

  it('pending_payment is invisible to the Orders tab and to the issue window', async () => {
    expect(await rowsOf(ids.order)).toEqual([]);
    expect(await db.getChipOrderSheetContext(await itemOf(ids.order, apt.owned))).toBeNull();
  });

  it('marks paid exactly once; the due date runs from the payment (72 working hours); one row per apartment', async () => {
    await db.setOrderGrowProcess(ids.order, `p${tag}`, 'tok');
    const sunday = new Date('2026-11-15T08:00:00Z');
    expect(await db.markChipOrderPaid(ids.order, { transactionId: 't1', transactionToken: 'tt', asmachta: 'a1' }, sunday)).toBe(true);
    expect(await db.markChipOrderPaid(ids.order, { transactionId: 't2', transactionToken: 'tt', asmachta: 'a2' })).toBe(false);
    const o = (await pool.query(`select status, grow_transaction_id, paid_at, due_at, approved_at from public.chip_orders where id = $1`, [ids.order])).rows[0];
    expect(o).toMatchObject({ status: 'paid', grow_transaction_id: 't1', approved_at: null });
    expect(new Date(o.paid_at).toISOString()).toBe('2026-11-15T08:00:00.000Z');
    expect(new Date(o.due_at).toISOString()).toBe('2026-11-18T08:00:00.000Z');
    const rows = await rowsOf(ids.order);
    expect(rows.map((r) => r.apartment_number).sort()).toEqual([apt.owned, apt.empty, apt.rented].sort());
    expect(rows.find((r) => r.apartment_number === apt.owned)).toMatchObject({ chips_count: 3, chips_linked: 0, status: 'paid', contact_id: ids.owned });
    const ctx = await db.getChipOrderSheetContext(await itemOf(ids.order, apt.owned));
    expect(JSON.stringify(ctx)).not.toContain('tok'); // the process token never reaches the screen
  });

  it('a paid order is assigned at once (no approval): only the group that carries the line is linked, more than ordered is allowed, and the tenants list is untouched', async () => {
    const owned = await itemOf(ids.order, apt.owned);
    const before = await contactRow(ids.owned);
    // A line of another apartment cannot be used here.
    await expect(issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`B${tag}1`], order_item_id: owned }] },
      admin,
    )).rejects.toThrow('order_item_not_found');

    // ONE save: the orderer's group (4 numbers for a line of 3) + another holder's group.
    const issued = await issueChipGroups(
      {
        contact_id: ids.owned,
        groups: [
          { resident_role: 'owner', holder_name: 'דנה כהן', holder_phone: '0539200001', chip_type: 'physical', numbers: [`A${tag}1`, `A${tag}2`, `A${tag}3`, `A${tag}4`], order_item_id: owned },
          { resident_role: 'other', holder_name: 'מטפלת', chip_type: 'physical', numbers: [`O${tag}1`] },
        ],
        limit_override_reason: 'בדיקה',
      },
      admin,
    );
    made.chips.push(...issued.items.map((c) => c.id));
    expect(issued.items).toHaveLength(5);
    const links = (await pool.query<{ chip_number: string; order_item_id: string | null }>(
      `select chip_number, order_item_id from public.chips where id = any($1::uuid[]) order by chip_number`, [issued.items.map((c) => c.id)],
    )).rows;
    expect(links.filter((c) => c.order_item_id === owned).map((c) => c.chip_number)).toEqual([`A${tag}1`, `A${tag}2`, `A${tag}3`, `A${tag}4`]);
    expect(links.find((c) => c.chip_number === `O${tag}1`)!.order_item_id).toBeNull();
    const ev = (await pool.query(`select event_type, new_value from public.chip_events where chip_id = $1`, [issued.items[0]!.id])).rows[0];
    expect(ev.event_type).toBe('issued');
    expect(ev.new_value.order_item_id).toBe(owned);
    // Issuing never writes to the tenants list.
    expect(await contactRow(ids.owned)).toEqual(before);
    expect((await rowsOf(ids.order)).find((r) => r.item_id === owned)).toMatchObject({ chips_linked: 4, chips_count: 3 });
  });

  it('ready only when every apartment of the order has its chips; collected drops every row; a closed order takes no more chips', async () => {
    const owned = await itemOf(ids.order, apt.owned);
    await expect(db.markChipOrderReady(ids.order)).rejects.toThrow('chips_missing');
    for (const [aptNo, cid, n] of [[apt.empty, ids.empty, 2], [apt.rented, ids.rented, 1]] as const) {
      const r = await issueChipGroups(
        { contact_id: cid, groups: [{ resident_role: 'other', holder_name: 'דנה כהן', chip_type: 'physical', numbers: Array.from({ length: n }, (_, k) => `${aptNo}-${k}`), order_item_id: await itemOf(ids.order, aptNo) }] },
        admin,
      );
      made.chips.push(...r.items.map((c) => c.id));
    }
    expect(await db.markChipOrderReady(ids.order)).toBe(true);
    await expect(db.markChipOrderReady(ids.order)).rejects.toThrow('not_assigning');
    expect((await rowsOf(ids.order)).every((r) => r.status === 'ready')).toBe(true);
    await expect(db.rejectChipOrder(ids.order, 'x')).rejects.toThrow('not_rejectable');
    // A replacement chip may still be linked while the order is ready.
    const extra = await issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', holder_name: 'דנה כהן', chip_type: 'physical', numbers: [`A${tag}5`], order_item_id: owned }], limit_override_reason: 'בדיקה' },
      admin,
    );
    made.chips.push(...extra.items.map((c) => c.id));
    expect(await db.markChipOrderCollected(ids.order)).toBe(true);
    expect(await rowsOf(ids.order)).toEqual([]);
    await expect(issueChipGroups(
      { contact_id: ids.owned, groups: [{ resident_role: 'owner', holder_name: 'דנה כהן', chip_type: 'physical', numbers: [`A${tag}6`], order_item_id: owned }], limit_override_reason: 'בדיקה' },
      admin,
    )).rejects.toThrow('order_not_open');
  });

  it('a chip issued without an order line is untouched by all this', async () => {
    const r = await issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'other', holder_name: 'שכן', chip_type: 'physical', numbers: [`Z${tag}9`] }] },
      admin,
    );
    made.chips.push(...r.items.map((c) => c.id));
    const row = (await pool.query(`select order_item_id from public.chips where id = $1`, [r.items[0]!.id])).rows[0];
    expect(row.order_item_id).toBeNull();
  });

  it('the issue window context: every OPEN order of the same phone for the apartment (oldest first) — another person\'s order and closed orders stay out', async () => {
    const mk = async (phone: string, name: string, lines: { apartmentNumber: string; chipsCount: number }[]) => {
      const o = await db.createChipOrder(
        { fullName: name, phoneE164: phone, email: 'x@example.test', address: 'כתובת 9', role: 'owner', ip: null,
          lines: lines.map((l) => ({ ...l, lease: null, leaseEndDate: null })) },
        DEFAULT_CHIP_ORDER_SETTINGS,
      );
      made.orders.push(o.id);
      await db.markChipOrderPaid(o.id, { transactionId: `t-${o.id}`, transactionToken: 'tt', asmachta: null });
      return o.id;
    };
    const first = await mk(PHONE, 'דנה כהן', [{ apartmentNumber: apt.owned, chipsCount: 1 }, { apartmentNumber: apt.empty, chipsCount: 1 }]);
    const other = await mk('+972539200077', 'אדם אחר', [{ apartmentNumber: apt.owned, chipsCount: 1 }]);
    const repeat = await mk(PHONE, 'דנה כהן', [{ apartmentNumber: apt.owned, chipsCount: 2 }]);
    const ctx = (await db.getChipOrderSheetContext(await itemOf(repeat, apt.owned)))!;
    expect(ctx).toMatchObject({ contact_id: ids.owned, apartment_number: apt.owned, holder: { full_name: 'דנה כהן', phone_e164: PHONE, role: 'owner' } });
    // ids.order (same phone) is collected → not a section.
    expect(ctx.sections.map((x) => x.order_id)).toEqual([first, repeat]);
    expect(ctx.sections[0]).toMatchObject({ other_apartments: [apt.empty], order_all_linked: false, chips_count: 1, chips_linked: 0, is_test: false });
    expect(ctx.sections.some((x) => x.order_id === other)).toBe(false);
    const otherCtx = (await db.getChipOrderSheetContext(await itemOf(other, apt.owned)))!;
    expect(otherCtx.sections.map((x) => x.order_id)).toEqual([other]);
    for (const id of [first, other, repeat]) await db.rejectChipOrder(id, 'ניקוי');
  });

  it('"עדכן בכרטיס הדייר": ONLY name + phone, into the slot of the order\'s role, never clearing; refused once the order is closed', async () => {
    const o = await db.createChipOrder(
      { fullName: 'שוכרת חדשה', phoneE164: '+972539200055', email: 'n@example.test', address: 'כתובת 5', role: 'tenant', ip: null,
        lines: [{ apartmentNumber: apt.rented, chipsCount: 1, leaseEndDate: '2027-06-30',
          lease: { objectKey: `00000000-0000-4000-8000-${tag}000005.pdf`, fileName: 'חוזה.pdf', mime: 'application/pdf', size: 99 } }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    await db.markChipOrderPaid(o.id, { transactionId: 't5', transactionToken: 'tt5', asmachta: null });
    const item = await itemOf(o.id, apt.rented);
    const before = await contactRow(ids.rented);
    await expect(db.writeOrderHolderToRegistry(item, { name: '  ', phone: null })).rejects.toThrow('nothing_to_write');
    await expect(db.writeOrderHolderToRegistry(item, { name: 'x', phone: '123' })).rejects.toThrow('invalid_phone');
    expect(await contactRow(ids.rented)).toEqual(before);

    const res = await db.writeOrderHolderToRegistry(item, { name: 'שוכרת בבלוק', phone: '053-920-0055' });
    expect(res).toMatchObject({ contact_id: ids.rented, apartment_number: apt.rented, role: 'tenant' });
    expect(await contactRow(ids.rented)).toEqual({ ...before, tenant_name: 'שוכרת בבלוק', tenant_phone: '0539200055' });
    // A phone alone leaves the name as it is (an empty value never clears).
    await db.writeOrderHolderToRegistry(item, { name: null, phone: '0539200056' });
    expect(await contactRow(ids.rented)).toMatchObject({ tenant_name: 'שוכרת בבלוק', tenant_phone: '0539200056', owner_name: before.owner_name });

    const ctx = (await db.getChipOrderSheetContext(item))!;
    expect(ctx.sections[0]).toMatchObject({ role: 'tenant', lease_file_name: 'חוזה.pdf', lease_end_date: '2027-06-30' });
    await db.rejectChipOrder(o.id, 'בדיקה');
    await expect(db.writeOrderHolderToRegistry(item, { name: 'x', phone: null })).rejects.toThrow('not_open');
    expect(await db.writeOrderHolderToRegistry('00000000-0000-4000-8000-000000000000', { name: 'x', phone: null })).toBeNull();
  });

  it('a deactivated chip no longer counts as delivered; reject waits until no active chip is left', async () => {
    const o = await db.createChipOrder(
      { fullName: 'רונית לוי', phoneE164: '+972539200003', email: 'r@example.test', address: 'כתובת 3', role: 'owner', ip: null,
        lines: [{ apartmentNumber: apt.empty, chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    await db.markChipOrderPaid(o.id, { transactionId: 't4', transactionToken: 'tt4', asmachta: null });
    const item = await itemOf(o.id, apt.empty);
    const first = await issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'other', holder_name: 'רונית לוי', chip_type: 'physical', numbers: [`R${tag}1`], order_item_id: item }] },
      admin,
    );
    made.chips.push(first.items[0]!.id);
    await expect(db.rejectChipOrder(o.id, 'בדיקה')).rejects.toThrow('chips_active');
    await deactivateChip(first.items[0]!.id, { reason: 'lost' }, admin);
    const replacement = await issueChipGroups(
      { contact_id: ids.empty, groups: [{ resident_role: 'other', holder_name: 'רונית לוי', chip_type: 'physical', numbers: [`R${tag}2`], order_item_id: item }] },
      admin,
    );
    made.chips.push(replacement.items[0]!.id);
    expect((await rowsOf(o.id))[0]).toMatchObject({ chips_count: 1, chips_linked: 1 });
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
    const item = (await pool.query(`select match_status, lease_file_name from public.chip_order_items where order_id = $1`, [o.id])).rows[0];
    expect(item).toMatchObject({ match_status: 'document_review', lease_file_name: 'חוזה.pdf' });
    const rej = await db.rejectChipOrder(o.id, 'החוזה לא בתוקף');
    expect(rej).toMatchObject({ total: 50, grow_transaction_id: 't3', grow_transaction_token: 'tt3' });
    await db.setChipOrderRefund(o.id, 'manual_required', 'Grow 110: ממתין לאישור');
    const after = (await pool.query(`select status, reject_reason, refund_status from public.chip_orders where id = $1`, [o.id])).rows[0];
    expect(after).toMatchObject({ status: 'rejected', reject_reason: 'החוזה לא בתוקף', refund_status: 'manual_required' });
    expect(await rowsOf(o.id)).toEqual([]);
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
