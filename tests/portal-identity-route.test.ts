import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { type ModulePermission, type Role } from '@/lib/permissions/constants';

// POST /api/admin/portal-identity — the permission gate, through the REAL
// staff guard chain (requirePermission → getCurrentActor → session +
// user_permissions): portal_manage:edit, the same check for every action on
// this route (approve / revoke / reject / rename). Exercised here through
// 'rename' (16/10/2026) — the decision logic itself is
// tests/portal-roles-identity.test.ts, against a real database.

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async () => ({ rows: h.permRows })),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));
vi.mock('@/lib/db/portal/identityApprovals', () => ({
  approveIdentity: vi.fn(),
  endIdentity: vi.fn(),
  renameIdentity: vi.fn(async () => true),
  IdentityDecisionError: class IdentityDecisionError extends Error {},
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from '@/app/api/admin/portal-identity/route';
import { renameIdentity } from '@/lib/db/portal/identityApprovals';

function signIn(role: Role, rows: ModulePermission[] = []) {
  h.session = { sid: 's', user: { id: `u-${role}`, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

const ID = '11111111-1111-4111-8111-111111111111';
const BODY = { action: 'rename', id: ID, display_name: 'שם חדש' };

function rename(body: unknown = BODY) {
  return POST(new NextRequest('http://localhost/api/admin/portal-identity', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
});

describe('POST /api/admin/portal-identity — who may rename', () => {
  it('no session → 401, nothing renamed', async () => {
    expect((await rename()).status).toBe(401);
    expect(renameIdentity).not.toHaveBeenCalled();
  });

  it('a manager with no portal_manage row is refused — deny by default', async () => {
    signIn('manager');
    expect((await rename()).status).toBe(403);
    expect(renameIdentity).not.toHaveBeenCalled();
  });

  it('portal_manage view-only is refused on rename (the action needs edit)', async () => {
    signIn('manager', [{ module: 'portal_manage', canView: true, canEdit: false }]);
    expect((await rename()).status).toBe(403);
    expect(renameIdentity).not.toHaveBeenCalled();
  });

  it('portal_manage:edit renames, attributing the change to the signed-in actor', async () => {
    signIn('manager', [{ module: 'portal_manage', canView: true, canEdit: true }]);
    const res = await rename();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(renameIdentity).toHaveBeenCalledWith(expect.anything(), { id: ID, displayName: 'שם חדש', actorId: 'u-manager' });
  });

  it('a 404 from the DB layer (no approved row with that id) surfaces as not_found', async () => {
    vi.mocked(renameIdentity).mockResolvedValueOnce(false);
    signIn('admin');
    const res = await rename();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
