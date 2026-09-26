import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// The assistant route's access contract (decision of 26/09/2026: the personal
// assistant is STAFF-ONLY, never for residents), exercised through the REAL
// guard chain — requireAssistantAccess → requireActor → getCurrentActor. Only
// the session lookup, the user_permissions read and the outside world
// (Anthropic, the debtors SQL, audit, logger) are mocked.
//   • no session                              → 401
//   • a role off the staff allowlist          → 403 (field worker, future resident)
//   • staff without dashboard/contacts view   → 403 (the gate it always had)
//   • admin / manager / viewer as today       → 200 + SSE stream

const h = vi.hoisted(() => ({
  session: null as null | {
    sid: string;
    user: { id: string; username: string; email: string; full_name: string | null; role: string };
  },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
}));

vi.mock('@/env', () => ({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: h.permRows })) }));
vi.mock('@/lib/db/debtors', () => ({ searchDebtors: vi.fn(async () => []) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));
vi.mock('@anthropic-ai/sdk', () => {
  // A one-turn model: streams a single text delta and stops without a tool call.
  class FakeStream {
    private onText: ((delta: string) => void)[] = [];
    on(event: string, cb: (delta: string) => void) {
      if (event === 'text') this.onText.push(cb);
      return this;
    }
    async finalMessage() {
      for (const cb of this.onText) cb('שלום');
      return { content: [{ type: 'text', text: 'שלום' }], stop_reason: 'end_turn' };
    }
  }
  class Anthropic {
    messages = { stream: () => new FakeStream() };
  }
  return { default: Anthropic };
});

import { POST } from '@/app/api/agent/chat/route';
import { searchDebtors } from '@/lib/db/debtors';

let seq = 0;
/** Sign in as `role` with the given matrix rows (ignored for the elevated roles, as in prod). */
function signIn(role: Role | 'resident', rows: ModulePermission[] = []) {
  seq += 1;
  h.session = {
    sid: `sid-${seq}`,
    // A fresh user id per call keeps the per-user rate limiter out of the picture.
    user: { id: `u-${role}-${seq}`, username: role, email: `${role}@test`, full_name: null, role },
  };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

function ask() {
  return POST(
    new NextRequest('http://localhost/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'מה החוב של דירה 12?' }] }),
    }),
  );
}

const dashView: ModulePermission[] = [{ module: 'dashboard', canView: true, canEdit: false }];

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
});

describe('POST /api/agent/chat — who may talk to the assistant', () => {
  it('no session → 401, and the debtors tool never runs', async () => {
    const res = await ask();
    expect(res.status).toBe(401);
    expect(searchDebtors).not.toHaveBeenCalled();
  });

  it('a field worker → 403, even when an admin granted dashboard view (allowlist beats matrix)', async () => {
    signIn('cleaner', DEFAULT_WORKER);
    expect((await ask()).status).toBe(403);
    signIn('maintenance', dashView);
    expect((await ask()).status).toBe(403);
    expect(searchDebtors).not.toHaveBeenCalled();
  });

  it('a role added later (a resident) → 403 by default — allowlist, not blocklist', async () => {
    signIn('resident', dashView);
    const res = await ask();
    expect(res.status).toBe(403);
    expect(searchDebtors).not.toHaveBeenCalled();
  });

  it('staff without dashboard/contacts view → 403 (the gate the assistant always had)', async () => {
    signIn('manager', []);
    expect((await ask()).status).toBe(403);
    signIn('viewer', []);
    expect((await ask()).status).toBe(403);
  });

  it('admin → 200 and the answer streams over SSE as before', async () => {
    signIn('admin');
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: text');
    expect(body).toContain('שלום');
    expect(body).toContain('event: done');
  });

  it('super_admin, manager (default matrix) and viewer (default matrix) → 200 as today', async () => {
    signIn('super_admin');
    expect((await ask()).status).toBe(200);
    signIn('manager', DEFAULT_MANAGER);
    expect((await ask()).status).toBe(200);
    signIn('viewer', DEFAULT_VIEWER);
    expect((await ask()).status).toBe(200);
  });
});
