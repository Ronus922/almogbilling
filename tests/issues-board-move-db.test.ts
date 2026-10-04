import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { requireSeededAdmin } from './db-fixtures';

// The manual issues kanban (04/10/2026) against a REAL database
// (WA_TEST_DATABASE_URL, a throwaway — never production): a new issue starts
// in the column of the stage rule, at the top; a drop writes board_column +
// sort_order and nothing else; the column then stays put when the panel saves
// a handler; and the outcomes the route maps to 404 / 409.
//
// Every test runs inside a transaction that is ALWAYS rolled back (iron rule
// 12; the same shape as tests/portal-issue-db.test.ts). Other suites' issues
// may share the database, so every assertion is about this file's own cards,
// relative to each other.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
let tx: PoolClient;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => tx.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await tx.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => fn(tx),
}));

const { createIssue, updateIssue, moveIssueOnBoard, getIssueById, listIssues } = await import('@/lib/db/issues');
const { insertPortalIssue } = await import('@/lib/db/portal/issueReport');
const { groupBoard, jerusalemToday } = await import('@/lib/issues/board');

const TODAY = jerusalemToday();

d('the manual issues kanban — the real SQL', () => {
  let adminId = '';
  const handler = () => [{ assignee_type: 'user' as const, id: adminId }];

  async function issue(title: string, opts: { handled?: boolean; due?: string | null } = {}) {
    return createIssue(
      { title: `DB-TEST board ${title}`, due_date: opts.due ?? null },
      opts.handled ? handler() : [],
      adminId, 'בדיקה', TODAY,
    );
  }
  /** This file's cards in one column, top to bottom, as the page groups them. */
  async function column(key: 'awaiting' | 'today' | 'in_progress', mine: string[]) {
    const board = groupBoard(await listIssues({}), TODAY);
    return board[key].map((i) => i.id).filter((id) => mine.includes(id));
  }
  async function row(id: string) {
    const r = await tx.query<{ board_column: string | null; sort_order: number }>(
      `select board_column, sort_order from public.issues where id = $1`, [id],
    );
    return r.rows[0]!;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
    pool.on('error', () => undefined);
    adminId = await requireSeededAdmin(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
  });
  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  it('a new issue starts in the column of the stage rule, above every existing card', async () => {
    const minBefore = (await tx.query<{ m: number }>(`select coalesce(min(sort_order), 0) as m from public.issues`)).rows[0]!.m;
    const awaiting = await issue('awaiting');
    const today = await issue('today', { handled: true, due: TODAY });
    const later = await issue('later', { handled: true, due: '2099-01-01' });
    expect([awaiting.board_column, today.board_column, later.board_column]).toEqual(['awaiting', 'today', 'in_progress']);
    expect(awaiting.sort_order).toBeLessThan(minBefore);
    expect(today.sort_order).toBeLessThan(awaiting.sort_order);
    expect(later.sort_order).toBeLessThan(today.sort_order);
  });

  it('a portal report starts in ממתין לשיוך, at the top', async () => {
    const top = await issue('staff first');
    const id = randomUUID();
    await insertPortalIssue({
      id,
      report: { location: 'לובי', area: '', description: 'DB-TEST board portal', urgency: 'medium' },
      reporter: { rosterId: null, apartmentNumber: null, role: null, name: 'לא מזוהה', phoneE164: '+972529990777' },
      images: [],
    });
    const r = await row(id);
    expect(r.board_column).toBe('awaiting');
    expect(r.sort_order).toBeLessThan(top.sort_order);
  });

  it('a drop between two cards of another column: lands there, writes only the dragged card, changes nothing else', async () => {
    const p1 = await issue('p1', { handled: true });
    const p2 = await issue('p2', { handled: true });
    const p3 = await issue('p3', { handled: true });
    const m = await issue('m');
    const mine = [p1.id, p2.id, p3.id, m.id];
    expect(await column('in_progress', mine)).toEqual([p3.id, p2.id, p1.id]);
    const neighbours = await Promise.all([p1.id, p2.id, p3.id].map(row));

    expect(await moveIssueOnBoard(m.id, 'in_progress', p2.id, TODAY)).toBe('moved');

    expect(await column('in_progress', mine)).toEqual([p3.id, m.id, p2.id, p1.id]);
    expect(await column('awaiting', mine)).toEqual([]);
    expect(await Promise.all([p1.id, p2.id, p3.id].map(row))).toEqual(neighbours);
    const after = await getIssueById(m.id);
    expect(after).toMatchObject({ board_column: 'in_progress', assignees: [], due_date: null, priority: m.priority, status: 'open' });
  });

  it('a reorder inside the column, and a drop to the bottom', async () => {
    const a = await issue('a', { handled: true, due: TODAY });
    const b = await issue('b', { handled: true, due: TODAY });
    const c = await issue('c', { handled: true, due: TODAY });
    const mine = [a.id, b.id, c.id];
    expect(await column('today', mine)).toEqual([c.id, b.id, a.id]);
    expect(await moveIssueOnBoard(a.id, 'today', c.id, TODAY)).toBe('moved');
    expect(await column('today', mine)).toEqual([a.id, c.id, b.id]);
    expect(await moveIssueOnBoard(c.id, 'today', null, TODAY)).toBe('moved');
    const board = groupBoard(await listIssues({}), TODAY).today.map((i) => i.id);
    expect(board[board.length - 1]).toBe(c.id);
  });

  it('a placed card stays put when the panel later saves a handler and a date', async () => {
    const x = await issue('x');
    expect(x.board_column).toBe('awaiting');
    const saved = await updateIssue(x.id, { due_date: TODAY }, handler(), adminId);
    expect(saved?.board_column).toBe('awaiting');
    expect(await column('awaiting', [x.id])).toEqual([x.id]);
  });

  it('not_found / not_on_board / stale', async () => {
    expect(await moveIssueOnBoard(randomUUID(), 'today', null, TODAY)).toBe('not_found');
    const closed = await issue('closed', { handled: true });
    await updateIssue(closed.id, { status: 'closed' });
    expect(await moveIssueOnBoard(closed.id, 'today', null, TODAY)).toBe('not_on_board');
    const m = await issue('stale-m');
    const elsewhere = await issue('stale-other', { handled: true });
    expect(await moveIssueOnBoard(m.id, 'today', elsewhere.id, TODAY)).toBe('stale');
    expect((await row(m.id)).board_column).toBe('awaiting');
  });
});
