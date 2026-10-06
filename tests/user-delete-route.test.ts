import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// DELETE /api/users/[id] — the permanent deletion of a staff user
// (06/10/2026), through the REAL guard chain (requireUserDeleteAccess →
// requireActor → getCurrentActor) and the real deleteUserPermanently; only the
// session lookup, the pool and the audit writer are fakes. What is locked:
//   • no session → 401; admin / manager / viewer → 403 — and nothing is touched;
//   • yourself → 403; an unknown id → 404;
//   • the last ACTIVE super admin → 403, a disabled one may go;
//   • the nominal owner of a WhatsApp instance → 409 (the FK cascades);
//   • the transaction's order: the name is written beside the id first, the
//     blocking references are cleared next, the account rows go last, with
//     public.users the very last statement; the audit row says 'deleted'.
// The database side (the rows really survive with the name) is
// tests/user-delete-db.test.ts.

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', username: 'ronen', email: 'r@x', full_name: 'רונן', role: 'super_admin' };
const TARGET = { id: '22222222-2222-4222-8222-222222222222', username: 'kobi', email: 'k@x', full_name: 'קובי אטיאס', role: 'manager', is_active: true, allow_google_auth: false, notification_phone: null, created_at: '2026-01-01' };

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  target: null as null | Record<string, unknown>,
  remainingSuperAdmins: 1,
  waOwned: 0,
  tx: [] as Array<{ sql: string; params: unknown[] }>,
  txRan: false,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/from public\.users\s+where id = \$1/.test(sql)) return params[0] === h.target?.id ? h.target : null;
    if (/role = 'super_admin' and is_active = true and id <> \$1/.test(sql)) return { count: h.remainingSuperAdmins };
    if (/from public\.whatsapp_instances where user_id = \$1/.test(sql)) return { n: h.waOwned };
    throw new Error(`unexpected queryOne: ${sql}`);
  }),
  withTransaction: vi.fn(async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    h.txRan = true;
    return fn({
      query: async (sql: string, params: unknown[] = []) => {
        h.tx.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^select count/.test(sql.trim())) return { rows: [{ n: 2 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    });
  }),
}));

import { DELETE } from '@/app/api/users/[id]/route';
import { writeAudit } from '@/lib/db/audit';

const call = (id: string) => DELETE(new NextRequest(`http://localhost/api/users/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
const asRole = (role: string, user = ADMIN) => { h.session = { sid: 's', user: { ...user, role } }; };

beforeEach(() => {
  h.session = null;
  h.target = { ...TARGET };
  h.remainingSuperAdmins = 1;
  h.waOwned = 0;
  h.tx = [];
  h.txRan = false;
  vi.mocked(writeAudit).mockClear();
});

describe('DELETE /api/users/[id] — who may', () => {
  it('no session → 401, nothing touched', async () => {
    const res = await call(TARGET.id);
    expect(res.status).toBe(401);
    expect(h.txRan).toBe(false);
  });

  it.each(['admin', 'manager', 'viewer', 'cleaner', 'maintenance'])('%s → 403, nothing touched', async (role) => {
    asRole(role);
    const res = await call(TARGET.id);
    expect(res.status).toBe(403);
    expect(h.txRan).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('super_admin → the deletion runs', async () => {
    asRole('super_admin');
    const res = await call(TARGET.id);
    expect(res.status).toBe(200);
    expect(h.txRan).toBe(true);
  });
});

describe('DELETE /api/users/[id] — who may be deleted', () => {
  it('an unknown id → 404', async () => {
    asRole('super_admin');
    h.target = null;
    expect((await call('33333333-3333-4333-8333-333333333333')).status).toBe(404);
    expect(h.txRan).toBe(false);
  });

  it('yourself → 403, even as super admin', async () => {
    asRole('super_admin');
    h.target = { ...TARGET, id: ADMIN.id, role: 'super_admin' };
    const res = await call(ADMIN.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'אסור למחוק את עצמך' });
    expect(h.txRan).toBe(false);
  });

  it('the last ACTIVE super admin → 403; a disabled super admin may go', async () => {
    asRole('super_admin');
    h.target = { ...TARGET, role: 'super_admin', is_active: true };
    h.remainingSuperAdmins = 0;
    const res = await call(TARGET.id);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/הסופר אדמין הפעיל האחרון/);
    expect(h.txRan).toBe(false);

    h.target = { ...TARGET, role: 'super_admin', is_active: false };
    expect((await call(TARGET.id)).status).toBe(200);
    expect(h.txRan).toBe(true);
  });

  it('a disabled manager may go (the whole point of "also on a disabled user")', async () => {
    asRole('super_admin');
    h.target = { ...TARGET, is_active: false };
    expect((await call(TARGET.id)).status).toBe(200);
  });

  it('the nominal owner of a WhatsApp instance → 409, nothing touched', async () => {
    asRole('super_admin');
    h.waOwned = 1;
    const res = await call(TARGET.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/WhatsApp/);
    expect(h.txRan).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/users/[id] — the transaction', () => {
  it('names first, then the blocking references, then the account — users last; the audit row says deleted', async () => {
    asRole('super_admin');
    const res = await call(TARGET.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).toMatchObject({ openIssuesUnassigned: 2, openTasksUnassigned: 2, openAssigneeRowsRemoved: 2, pendingRemindersUnassigned: 2 });

    const sqls = h.tx.map((t) => t.sql);
    const snapshotIdx = sqls.map((s, i) => (/^update public\.\w+ set \w+ = \$2 where/.test(s) ? i : -1)).filter((i) => i >= 0);
    const clearIdx = sqls.map((s, i) => (/^update public\.\w+ set \w+ = null where/.test(s) ? i : -1)).filter((i) => i >= 0);
    const deleteIdx = sqls.map((s, i) => (/^delete from/.test(s) ? i : -1)).filter((i) => i >= 0);
    expect(snapshotIdx.length).toBeGreaterThanOrEqual(23);
    expect(clearIdx).toHaveLength(16);
    expect(deleteIdx).toHaveLength(4);
    expect(Math.max(...snapshotIdx)).toBeLessThan(Math.min(...clearIdx));
    expect(Math.max(...clearIdx)).toBeLessThan(Math.min(...deleteIdx));
    expect(sqls[sqls.length - 1]).toBe('delete from public.users where id = $1');
    expect(sqls.slice(-4, -1)).toEqual([
      'delete from public.sessions where user_id = $1',
      'delete from public.user_permissions where user_id = $1',
      'delete from public.password_reset_tokens where user_id = $1',
    ]);

    // the name written is full_name, the id is the target's — everywhere
    for (const i of snapshotIdx) {
      expect(h.tx[i]!.params).toEqual([TARGET.id, 'קובי אטיאס']);
      expect(sqls[i]).toMatch(/ is null$/);
    }
    for (const i of clearIdx) expect(h.tx[i]!.params).toEqual([TARGET.id]);

    // the six snapshot columns added on 06/10/2026 are among the first step
    for (const col of ['chat_messages set sent_by_name', 'wa_campaigns set created_by_name', 'documents set uploaded_by_name', 'document_folders set created_by_name', 'user_reminders set created_by_name', 'audit_log set actor_name']) {
      expect(sqls.some((s) => s.includes(`update public.${col} = $2`)), col).toBe(true);
    }
    // the five formerly NOT NULL references are cleared
    for (const col of ['document_folders set created_by', 'documents set uploaded_by', 'reminder_categories set created_by', 'user_invites set invited_by', 'user_reminders set created_by']) {
      expect(sqls.some((s) => s.includes(`update public.${col} = null`)), col).toBe(true);
    }

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAudit).mock.calls[0]![0]).toMatchObject({
      actorUserId: ADMIN.id,
      action: 'deleted',
      entityType: 'user',
      entityId: TARGET.id,
      metadata: { email: 'k@x', role: 'manager', was_active: true, openIssuesUnassigned: 2, actor_role: 'super_admin' },
    });
  });

  it('a user without a full name is written under the username', async () => {
    asRole('super_admin');
    h.target = { ...TARGET, full_name: null };
    await call(TARGET.id);
    const snapshot = h.tx.find((t) => /set \w+ = \$2 where/.test(t.sql));
    expect(snapshot?.params).toEqual([TARGET.id, 'kobi']);
  });
});
