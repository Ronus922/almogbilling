import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// PATCH /api/issues/[id]/move — a drop on the manual issues kanban
// (04/10/2026), through the REAL staff guard chain (requirePermission →
// getCurrentActor → session + user_permissions): issues:edit only, never a
// field worker, a validated body, and the DB layer's outcome mapped to a
// status. The SQL itself is tests/issues-board-move-db.test.ts.

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
  result: 'moved' as string,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: h.permRows })) }));
vi.mock('@/lib/db/issues', () => ({ moveIssueOnBoard: vi.fn(async () => h.result) }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { PATCH as move } from '@/app/api/issues/[id]/move/route';
import { moveIssueOnBoard } from '@/lib/db/issues';

const ID = '11111111-1111-4111-8111-111111111111';
const BEFORE = '22222222-2222-4222-8222-222222222222';

function signIn(role: Role, rows: ModulePermission[] = []) {
  h.session = { sid: 's', user: { id: `u-${role}`, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

async function drop(body: unknown, id = ID) {
  const res = await move(
    new NextRequest(`http://localhost/api/issues/${id}/move`, {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
  h.result = 'moved';
});

describe('PATCH /api/issues/[id]/move — who may drop', () => {
  it('no session → 401, nothing written', async () => {
    expect((await drop({ column: 'today', before_id: null })).status).toBe(401);
    expect(moveIssueOnBoard).not.toHaveBeenCalled();
  });

  it('issues:view without issues:edit → 403', async () => {
    signIn('viewer', [{ module: 'issues', canView: true, canEdit: false }]);
    expect((await drop({ column: 'today', before_id: null })).status).toBe(403);
    expect(moveIssueOnBoard).not.toHaveBeenCalled();
  });

  it('a field worker (issues:edit on their own faults, but no board) → 403', async () => {
    signIn('cleaner', DEFAULT_WORKER);
    expect((await drop({ column: 'today', before_id: null })).status).toBe(403);
    expect(moveIssueOnBoard).not.toHaveBeenCalled();
  });

  it('a manager and an admin → 200, with the column, the neighbour and the Jerusalem day', async () => {
    signIn('manager', DEFAULT_MANAGER);
    expect(await drop({ column: 'awaiting', before_id: BEFORE })).toEqual({ status: 200, body: { ok: true } });
    expect(moveIssueOnBoard).toHaveBeenCalledWith(ID, 'awaiting', BEFORE, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    signIn('admin');
    expect((await drop({ column: 'in_progress', before_id: null })).status).toBe(200);
    expect(moveIssueOnBoard).toHaveBeenLastCalledWith(ID, 'in_progress', null, expect.any(String));
  });
});

describe('PATCH /api/issues/[id]/move — the body', () => {
  beforeEach(() => signIn('admin'));

  it('"בוצע" is a status, not a column; anything else is refused too', async () => {
    for (const column of ['done', 'closed', '', null]) {
      const r = await drop({ column, before_id: null });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_column');
    }
    expect(moveIssueOnBoard).not.toHaveBeenCalled();
  });

  it('before_id must be a uuid or null — and must be sent', async () => {
    expect((await drop({ column: 'today', before_id: 'x' })).body.error).toBe('invalid_before_id');
    expect((await drop({ column: 'today' })).status).toBe(400);
    expect((await drop('{oops')).body.error).toBe('invalid_json');
    expect(moveIssueOnBoard).not.toHaveBeenCalled();
  });

  it('a malformed id is the same 404 as a missing issue', async () => {
    expect((await drop({ column: 'today', before_id: null }, 'not-a-uuid')).status).toBe(404);
    h.result = 'not_found';
    expect((await drop({ column: 'today', before_id: null })).status).toBe(404);
  });

  it('closed / archived meanwhile, or a stale neighbour → 409 (the page puts the card back)', async () => {
    h.result = 'not_on_board';
    expect(await drop({ column: 'today', before_id: null })).toEqual({ status: 409, body: { error: 'not_on_board' } });
    h.result = 'stale';
    expect(await drop({ column: 'today', before_id: BEFORE })).toEqual({ status: 409, body: { error: 'stale' } });
  });
});
