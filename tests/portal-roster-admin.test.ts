import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MANAGER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// The portal roster's admin surface — "טלפון ← דירות בפורטל" on the apartment
// card and /admin/portal-blocked — through the REAL staff guard chain
// (requirePermission → getCurrentActor → session + user_permissions).
//
// Decision 5 of the 03/10/2026 audit: a phone reaches the portal through the
// apartment's owner record and NOTHING else. So the admin can look and detach,
// and cannot add, rename or switch a link back on:
//   • the owner-phones route has no POST, and the db layer no create;
//   • PATCH accepts exactly { id, is_active: false } — anything else is a 400;
//   • a detach is logged (audit_log) with the actor and the reason;
//   • portal_manage gates all of it — a default manager gets 403.

const APT = '520';
const ROW_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
  stillActive: null as null | { n: number },
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({
  // user_permissions for the guard; `select 1 … contacts` for apartmentExists.
  query: vi.fn(async () => ({ rows: h.permRows })),
  queryOne: vi.fn(async (sql: string) =>
    sql.includes('from public.contacts') ? { n: 1 } : h.stillActive),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({
  listOwnerPhones: vi.fn(async () => []),
  listBlockedPortalPhones: vi.fn(async () => []),
  detachOwnerPhone: vi.fn(async (apartment: string, id: string) => ({
    id, apartment_number: apartment, phone_e164: '+972525460546', owner_name: 'טלי בדיקה',
  })),
}));
vi.mock('@/lib/db/portal/sessions', () => ({ revokePortalSessionsForPhone: vi.fn(async () => 1) }));
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));

const route = await import('@/app/api/apartments/[apartment]/owner-phones/route');
const blocked = await import('@/app/api/admin/portal-blocked/route');
const { detachOwnerPhone, listBlockedPortalPhones } = await import('@/lib/db/portal/ownerPhones');
const { writeAudit } = await import('@/lib/db/audit');
const { revokePortalSessionsForPhone } = await import('@/lib/db/portal/sessions');
const { ownerPhoneDetachBodySchema } = await import('@/lib/validation/requests');

function signIn(role: Role, rows: ModulePermission[] = [], id = `u-${role}`) {
  h.session = { sid: 's', user: { id, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

function patch(body: unknown) {
  return route.PATCH(
    new Request(`http://localhost/api/apartments/${APT}/owner-phones`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ apartment: APT }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
  h.stillActive = null;
});

describe('the admin screen cannot add a link', () => {
  it('the owner-phones route has no POST, and the db layer no create / update', async () => {
    expect('POST' in route).toBe(false);
    const real = await vi.importActual<Record<string, unknown>>('@/lib/db/portal/ownerPhones');
    expect(Object.keys(real)).not.toContain('createOwnerPhone');
    expect(Object.keys(real)).not.toContain('updateOwnerPhone');
  });

  it('PATCH takes exactly { id, is_active: false } — no re-activation, no rename', async () => {
    expect(ownerPhoneDetachBodySchema.safeParse({ id: ROW_ID, is_active: false }).success).toBe(true);
    expect(ownerPhoneDetachBodySchema.safeParse({ id: ROW_ID, is_active: true }).success).toBe(false);
    expect(ownerPhoneDetachBodySchema.safeParse({ id: ROW_ID, is_active: false, owner_name: 'x' }).success).toBe(false);
    expect(ownerPhoneDetachBodySchema.safeParse({ id: ROW_ID, phone: '0525460546' }).success).toBe(false);

    signIn('admin');
    expect((await patch({ id: ROW_ID, is_active: true })).status).toBe(400);
    expect((await patch({ id: ROW_ID, owner_name: 'שם חדש' })).status).toBe(400);
    expect(detachOwnerPhone).not.toHaveBeenCalled();
  });
});

describe('detach', () => {
  it('an admin detaches: scoped to the apartment, logged with actor + reason, sessions closed when nothing is left', async () => {
    signIn('admin', [], 'u-admin');
    const res = await patch({ id: ROW_ID, is_active: false });
    expect(res.status).toBe(200);
    expect(detachOwnerPhone).toHaveBeenCalledWith(APT, ROW_ID, 'u-admin');
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'u-admin',
      action: 'portal_owner_phone_detached',
      entityType: 'apartment_owner_phone',
      entityId: ROW_ID,
      metadata: expect.objectContaining({ apartment_number: APT, reason: 'admin' }),
    }));
    expect(revokePortalSessionsForPhone).toHaveBeenCalledWith('+972525460546');
  });

  it('the phone still opening another apartment keeps its sessions', async () => {
    signIn('admin');
    h.stillActive = { n: 1 };
    expect((await patch({ id: ROW_ID, is_active: false })).status).toBe(200);
    expect(revokePortalSessionsForPhone).not.toHaveBeenCalled();
  });

  it('portal_manage gates it — a default manager gets 403 and nothing is written', async () => {
    signIn('manager', DEFAULT_MANAGER);
    expect((await patch({ id: ROW_ID, is_active: false })).status).toBe(403);
    expect(detachOwnerPhone).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('/api/admin/portal-blocked', () => {
  it('admin reads it; a default manager gets 403; nobody signed in gets 401', async () => {
    signIn('admin');
    expect((await blocked.GET()).status).toBe(200);
    signIn('manager', DEFAULT_MANAGER);
    expect((await blocked.GET()).status).toBe(403);
    h.session = null;
    expect((await blocked.GET()).status).toBe(401);
    expect(listBlockedPortalPhones).toHaveBeenCalledTimes(1);
  });
});
