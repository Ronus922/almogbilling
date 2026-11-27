import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { ModulePermission, Role } from '@/lib/permissions/constants';

// "עדכן בכרטיס הדייר" (13/11/2026) — the ONLY path from a chip order to the
// tenants list, through its route, against a throwaway database
// (WA_TEST_DATABASE_URL), never prod:
//   · contacts:edit is enforced ON THE SERVER — a user who handles orders but
//     cannot edit the tenants list gets 403 and nothing is written;
//   · handling orders (chips_orders_manage:edit) is required as well;
//   · with both, exactly the block's name + phone land in the slot of the
//     order's role, audited;
//   · nothing else writes: paying the order (an approved card charge,
//     recordCardPayment) and issuing its chips leave the tenants list as it was.
// The session is mocked (a manager with the permissions under test); the
// permission check itself is the real hasPermission. Fixtures are a numeric
// apartment far from the seed, removed by exact ids.
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

const h = vi.hoisted(() => ({
  actor: null as null | { id: string; name: string; role: Role; permissions: ModulePermission[] },
}));
vi.mock('@/lib/auth/actor', async () => {
  const { AuthorizationError } = await import('@/lib/auth/errors');
  const { hasPermission } = await import('@/lib/permissions/check');
  return {
    requirePermission: vi.fn(async (module: string, action: 'view' | 'edit') => {
      if (!h.actor || !hasPermission(h.actor.role, h.actor.permissions, module, action)) {
        throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
      }
      return { ...h.actor, isAuthenticated: true as const };
    }),
  };
});
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(fn); },
}));

const { requireSeededAdmin } = await import('./db-fixtures');
const { POST: writeRegistry } = await import('@/app/api/chip-orders/items/[itemId]/registry/route');
const db = await import('@/lib/db/chipOrders');
const { recordCardPayment, setCardSession } = await import('@/lib/db/chipOrderCard');
const { issueChipGroups } = await import('@/lib/db/chips');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const APT = `993${tag}1`;
const made = { contact: '', order: '', chips: [] as string[] };
let adminId = '';
let itemId = '';

const perms = (...mods: [string, boolean][]): ModulePermission[] =>
  mods.map(([module, canEdit]) => ({ module, canView: true, canEdit }));

function call(body: unknown) {
  return writeRegistry(
    new Request(`http://local/api/chip-orders/items/${itemId}/registry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ itemId }) },
  );
}
const contact = async () =>
  (await pool.query(`select owner_name, owner_phone, owner_email, tenant_name, tenant_phone from public.contacts where id = $1`, [made.contact])).rows[0];

d('"עדכן בכרטיס הדייר" route', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    adminId = await requireSeededAdmin(pool);
    made.contact = (await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים קיים', '0539500009') returning id`, [APT],
    )).rows[0]!.id;
    const o = await db.createChipOrder(
      { fullName: 'מזמינה חדשה', phoneE164: '+972539500001', email: 'o@example.test', address: 'כתובת 1', role: 'owner', ip: null,
        lines: [{ apartmentNumber: APT, chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.order = o.id;
    itemId = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [o.id])).rows[0]!.id;
  });

  afterAll(async () => {
    if (!pool) return;
    for (const id of made.chips) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    if (made.order) {
      // A document row of the order (Morning, 26/11/2026) blocks deleting it — by the order's id.
      await pool.query(`delete from public.chip_order_documents where order_id = $1`, [made.order])
        .catch((e: { code?: string }) => { if (e.code !== '42P01') throw e; });
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [made.order]);
      await pool.query(`delete from public.chip_orders where id = $1`, [made.order]);
    }
    if (made.contact) await pool.query(`delete from public.contacts where id = $1`, [made.contact]);
    await pool.end();
  });

  it('paying the order (its card charge) and issuing its chips write nothing to the tenants list', async () => {
    const before = await contact();
    const o = (await pool.query<{ order_number: number; total: number }>(
      `select order_number, total::float8 as total from public.chip_orders where id = $1`, [made.order],
    )).rows[0]!;
    const session = `registry-${tag}-session`;
    expect(await setCardSession(made.order, { env: 'production', pageRequestUid: session, amount: o.total })).toBe(true);
    expect(await recordCardPayment({
      env: 'production', orderNumber: o.order_number, transactionUid: `tx-registry-${tag}`, pageRequestUid: session,
      amount: o.total, approvalNumber: null, last4: null,
    }, 'payplus_callback')).toEqual({ kind: 'paid', orderId: made.order });
    const r = await issueChipGroups(
      { contact_id: made.contact, groups: [{ resident_role: 'owner', holder_name: 'מזמינה חדשה', holder_phone: '0539500001', chip_type: 'physical', numbers: [`G${tag}1`], order_item_id: itemId }] },
      { id: adminId, name: 'e2e-admin' },
    );
    made.chips.push(...r.items.map((c) => c.id));
    expect(await contact()).toEqual(before);
  });

  it('handles orders but no contacts:edit → 403, nothing written', async () => {
    const before = await contact();
    h.actor = { id: adminId, name: 'מנהל', role: 'manager', permissions: perms(['chips_orders_manage', true], ['contacts', false]) };
    const res = await call({ name: 'מזמינה חדשה', phone: '0539500001' });
    expect(res.status).toBe(403);
    expect(await contact()).toEqual(before);
  });

  it('contacts:edit but no chips_orders_manage:edit → 403, nothing written', async () => {
    const before = await contact();
    h.actor = { id: adminId, name: 'מנהל', role: 'manager', permissions: perms(['chips_orders_manage', false], ['contacts', true]) };
    const res = await call({ name: 'מזמינה חדשה', phone: '0539500001' });
    expect(res.status).toBe(403);
    expect(await contact()).toEqual(before);
  });

  it('with both: exactly the name + phone, in the order role\'s slot, and an audit row', async () => {
    const before = await contact();
    h.actor = { id: adminId, name: 'מנהל', role: 'manager', permissions: perms(['chips_orders_manage', true], ['contacts', true]) };
    afterQueue.length = 0;
    const res = await call({ name: 'מזמינה חדשה', phone: '053-950-0001' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, role: 'owner' });
    expect(await contact()).toEqual({ ...before, owner_name: 'מזמינה חדשה', owner_phone: '0539500001' });
    expect(afterQueue).toHaveLength(1);
  });

  it('an empty body or a bad phone is refused', async () => {
    h.actor = { id: adminId, name: 'מנהל', role: 'manager', permissions: perms(['chips_orders_manage', true], ['contacts', true]) };
    expect((await call({ name: '', phone: '' })).status).toBe(400);
    expect((await call({ name: 'x', phone: '12' })).status).toBe(400);
  });
});
