import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { applyOrder, compareReminders, reorderIds } from '@/lib/userReminders/order';

// The per-user order of the reminders list (06/10/2026):
//   • the pure arithmetic of a drop (lib/userReminders/order.ts) — the dragged
//     card above the card under the pointer, or after the last card the user
//     could see; the list sorted as the server sorts it;
//   • PUT /api/user-reminders/order through the REAL guard chain and the real
//     setUserReminderOrder: 401 / 400 for a bad body / 404 for an unknown id /
//     403 for someone else's — and then nothing is written; 200 writes the
//     SESSION user's rows alone, positions 0..n-1 for exactly the ids sent.

const UID = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ME = { id: UID('a'), username: 'alef', email: 'a@x', full_name: 'אלף', role: 'super_admin' };
const [R1, R2, R3, R4] = [UID('1'), UID('2'), UID('3'), UID('4')];

const item = (id: string, remind_at: string, position: number | null) => ({ id, remind_at, position });

describe('compareReminders', () => {
  it('placed first by position, then the rest by remind_at, the id last', () => {
    const list = [
      item(R3, '2026-10-07T09:00:00Z', null),
      item(R1, '2026-10-09T09:00:00Z', 1),
      item(R2, '2026-10-08T09:00:00Z', 0),
      item(R4, '2026-10-07T09:00:00Z', null),
    ];
    expect([...list].sort(compareReminders).map((r) => r.id)).toEqual([R2, R1, R3, R4]);
  });
});

describe('reorderIds', () => {
  const tab = [R1, R2, R3, R4];
  it('above a card', () => {
    expect(reorderIds(tab, R3, R1, R4)).toEqual([R3, R1, R2, R4]);
    expect(reorderIds(tab, R1, R4, R4)).toEqual([R2, R3, R1, R4]);
  });
  it('at the bottom of what is shown: after the last visible card, hidden ones keep their places', () => {
    // A category filter shows R1 and R3 only; R3 is the last card on screen.
    expect(reorderIds(tab, R1, null, R3)).toEqual([R2, R3, R1, R4]);
    // Nothing visible after it / no visible card: the end of the tab.
    expect(reorderIds(tab, R1, null, R4)).toEqual([R2, R3, R4, R1]);
    expect(reorderIds(tab, R1, null, null)).toEqual([R2, R3, R4, R1]);
  });
  it('a drop on itself or above an unknown card changes nothing but puts it last', () => {
    expect(reorderIds(tab, R2, R2, R2)).toEqual([R1, R3, R4, R2]);
    expect(reorderIds(tab, R2, UID('9'), null)).toEqual([R1, R3, R4, R2]);
  });
});

describe('applyOrder', () => {
  it('writes 0..n-1 on the tab\'s ids, leaves the others, sorts the lot', () => {
    const list = [
      item(R1, '2026-10-07T09:00:00Z', 0),
      item(R2, '2026-10-08T09:00:00Z', 1),
      item(R3, '2026-10-06T09:00:00Z', null), // the other tab, never dragged
    ];
    const next = applyOrder(list, [R2, R1]);
    expect(next.map((r) => [r.id, r.position])).toEqual([[R2, 0], [R1, 1], [R3, null]]);
    expect(list[0].position, 'the input is not mutated').toBe(0);
  });
});

// ── the route ──────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  /** What the involvement query finds: id → involved. */
  found: new Map<string, boolean>(),
  tx: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryOne: vi.fn(async (sql: string) => { throw new Error(`unexpected queryOne: ${sql}`); }),
  withTransaction: vi.fn(async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        h.tx.push({ sql: flat, params });
        if (/^select id, \(created_by = \$1 or assigned_to = \$1\) as involved/.test(flat)) {
          const rows = (params[1] as string[]).filter((id) => h.found.has(id)).map((id) => ({ id, involved: h.found.get(id)! }));
          return { rows, rowCount: rows.length };
        }
        if (/^insert into public\.user_reminder_order/.test(flat)) return { rows: [], rowCount: (params[1] as string[]).length };
        throw new Error(`unexpected tx query: ${flat}`);
      },
    })),
}));

import { PUT } from '@/app/api/user-reminders/order/route';

const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost/api/user-reminders/order', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
const inserts = () => h.tx.filter((c) => /^insert/.test(c.sql));

beforeEach(() => {
  h.session = null;
  h.found = new Map([[R1, true], [R2, true], [R3, false]]);
  h.tx = [];
});

describe('PUT /api/user-reminders/order', () => {
  it('no session → 401, nothing written', async () => {
    expect((await put({ ids: [R1] })).status).toBe(401);
    expect(h.tx).toHaveLength(0);
  });

  it.each([
    ['no ids', {}],
    ['an empty list', { ids: [] }],
    ['a non-uuid', { ids: ['x'] }],
    ['a duplicate', { ids: [R1, R1] }],
    ['broken JSON', '{nope'],
  ])('%s → 400, nothing written', async (_what, body) => {
    h.session = { sid: 's', user: ME };
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(h.tx).toHaveLength(0);
  });

  it('an unknown (or archived) id → 404, nothing written', async () => {
    h.session = { sid: 's', user: ME };
    const res = await put({ ids: [R1, R4] });
    expect(res.status).toBe(404);
    expect(inserts()).toHaveLength(0);
  });

  it('someone else\'s reminder → 403, nothing written', async () => {
    h.session = { sid: 's', user: ME };
    const res = await put({ ids: [R1, R3] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(inserts()).toHaveLength(0);
  });

  it('my reminders → 200: the session user\'s rows, positions 0..n-1 for exactly these ids', async () => {
    h.session = { sid: 's', user: ME };
    const res = await put({ ids: [R2, R1] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.tx[0].params[0], 'the involvement check is for the session user').toBe(ME.id);
    const ins = inserts();
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toMatch(/on conflict \(user_id, reminder_id\) do update set position = excluded\.position/);
    expect(ins[0].params).toEqual([ME.id, [R2, R1], [0, 1]]);
  });
});
