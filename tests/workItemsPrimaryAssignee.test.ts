import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The unified module's primary-assignee writer (11/10/2026) against a REAL
// database (WA_TEST_DATABASE_URL, a throwaway — never production): setting a
// primary assignee must write BOTH the fast-path scalar column AND keep
// entity_assignees in sync as exactly one row, so every pre-existing consumer
// of the junction (worker row-scoping via issueAccess, assignment
// notifications, the multi-assignee display) keeps working unchanged — the
// supplier-assignment capability this module promises to preserve.
//
// Every test runs inside a transaction that is ALWAYS rolled back (iron rule
// 12; the same shape as tests/issues-board-move-db.test.ts).
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

const { createIssue, setIssuePrimaryAssignee } = await import('@/lib/db/issues');
const { createTask, setTaskPrimaryAssignee } = await import('@/lib/db/tasks');
const { reorderWorkItemWithinLane } = await import('@/lib/db/workItems');

d('setIssuePrimaryAssignee / setTaskPrimaryAssignee — scalar + junction in sync', () => {
  let adminId = '';
  let supplierId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    adminId = await requireSeededAdmin(pool);
  });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
    const sup = await tx.query<{ id: string }>(
      `insert into public.suppliers (display_name, email, status) values ('DB-TEST ספק', 'dbtest-supplier@example.com', 'active') returning id`,
    );
    supplierId = sup.rows[0]!.id;
  });

  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  it('assigning a user writes assignee_user_id and a single entity_assignees row', async () => {
    const issue = await createIssue({ title: 'DB-TEST assign user' }, [], adminId, 'בדיקה', '2026-01-01');
    const updated = await setIssuePrimaryAssignee(issue.id, { kind: 'user', id: adminId }, adminId);
    expect(updated?.assignee_user_id).toBe(adminId);
    expect(updated?.assignee_supplier_id).toBeNull();
    const junction = await tx.query(
      `select assignee_type, user_id, supplier_id from public.entity_assignees where entity_type = 'issue' and entity_id = $1`,
      [issue.id],
    );
    expect(junction.rows).toEqual([{ assignee_type: 'user', user_id: adminId, supplier_id: null }]);
  });

  it('assigning a supplier (preserved capability) writes assignee_supplier_id and the junction', async () => {
    const task = await createTask({ title: 'DB-TEST assign supplier' }, [], adminId, 'בדיקה');
    const updated = await setTaskPrimaryAssignee(task.id, { kind: 'supplier', id: supplierId }, adminId);
    expect(updated?.assignee_supplier_id).toBe(supplierId);
    expect(updated?.assignee_user_id).toBeNull();
    const junction = await tx.query(
      `select assignee_type, user_id, supplier_id from public.entity_assignees where entity_type = 'task' and entity_id = $1`,
      [task.id],
    );
    expect(junction.rows).toEqual([{ assignee_type: 'supplier', user_id: null, supplier_id: supplierId }]);
  });

  it('re-assigning replaces the previous primary — never two rows at once', async () => {
    const issue = await createIssue({ title: 'DB-TEST reassign' }, [], adminId, 'בדיקה', '2026-01-01');
    await setIssuePrimaryAssignee(issue.id, { kind: 'user', id: adminId }, adminId);
    await setIssuePrimaryAssignee(issue.id, { kind: 'supplier', id: supplierId }, adminId);
    const junction = await tx.query(
      `select assignee_type from public.entity_assignees where entity_type = 'issue' and entity_id = $1`,
      [issue.id],
    );
    expect(junction.rows).toEqual([{ assignee_type: 'supplier' }]);
  });

  it('clearing the assignee (null) empties both the scalar columns and the junction', async () => {
    const task = await createTask({ title: 'DB-TEST clear' }, [], adminId, 'בדיקה');
    await setTaskPrimaryAssignee(task.id, { kind: 'user', id: adminId }, adminId);
    const cleared = await setTaskPrimaryAssignee(task.id, null, adminId);
    expect(cleared?.assignee_user_id).toBeNull();
    expect(cleared?.assignee_supplier_id).toBeNull();
    const junction = await tx.query(
      `select 1 from public.entity_assignees where entity_type = 'task' and entity_id = $1`,
      [task.id],
    );
    expect(junction.rowCount).toBe(0);
  });

  // 19/10/2026 — create with exactly ONE assignee also sets the primary (the
  // kanban lane key); several or none leave the item in "ממתינים לשיבוץ".
  it('createIssue with one user assignee sets assignee_user_id and keeps the single junction row', async () => {
    const issue = await createIssue({ title: 'DB-TEST create one user' }, [{ assignee_type: 'user', id: adminId }], adminId, 'בדיקה', '2026-01-01');
    expect(issue.assignee_user_id).toBe(adminId);
    expect(issue.assignee_supplier_id).toBeNull();
    expect(issue.assignees).toHaveLength(1);
  });

  it('createTask with one supplier assignee sets assignee_supplier_id', async () => {
    const task = await createTask({ title: 'DB-TEST create one supplier' }, [{ assignee_type: 'supplier', id: supplierId }], adminId, 'בדיקה');
    expect(task.assignee_supplier_id).toBe(supplierId);
    expect(task.assignee_user_id).toBeNull();
  });

  it('createIssue/createTask with several assignees or none leave the primary empty', async () => {
    const two = await createIssue(
      { title: 'DB-TEST create two' },
      [{ assignee_type: 'user', id: adminId }, { assignee_type: 'supplier', id: supplierId }],
      adminId, 'בדיקה', '2026-01-01',
    );
    expect(two.assignee_user_id).toBeNull();
    expect(two.assignee_supplier_id).toBeNull();
    expect(two.assignees).toHaveLength(2);
    const none = await createTask({ title: 'DB-TEST create none' }, [], adminId, 'בדיקה');
    expect(none.assignee_user_id).toBeNull();
    expect(none.assignee_supplier_id).toBeNull();
  });

  it('a non-existent id returns null without throwing', async () => {
    expect(await setIssuePrimaryAssignee('00000000-0000-4000-8000-000000000000', null, adminId)).toBeNull();
  });
});

d('reorderWorkItemWithinLane — fractional sort_index, same-lane-only', () => {
  let adminId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    adminId = await requireSeededAdmin(pool);
  });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
  });

  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  it('a first reorder in an empty lane+tier sets sort_index to 0', async () => {
    const t = await createTask({ title: 'DB-TEST reorder solo', priority: 'high' }, [], adminId, 'בדיקה');
    await setTaskPrimaryAssignee(t.id, { kind: 'user', id: adminId }, adminId);
    const result = await reorderWorkItemWithinLane('task', t.id, null);
    expect(result).toBe('moved');
    const row = await tx.query<{ sort_index: string }>(`select sort_index from public.tasks where id = $1`, [t.id]);
    expect(Number(row.rows[0]!.sort_index)).toBe(0);
  });

  it('dropping before a sibling in a different priority tier is rejected (cross_lane)', async () => {
    const a = await createTask({ title: 'DB-TEST tier A', priority: 'urgent' }, [], adminId, 'בדיקה');
    const b = await createTask({ title: 'DB-TEST tier B', priority: 'normal' }, [], adminId, 'בדיקה');
    await setTaskPrimaryAssignee(a.id, { kind: 'user', id: adminId }, adminId);
    await setTaskPrimaryAssignee(b.id, { kind: 'user', id: adminId }, adminId);
    expect(await reorderWorkItemWithinLane('task', a.id, b.id)).toBe('cross_lane');
  });

  it('reordering between two siblings lands a midpoint sort_index', async () => {
    const a = await createTask({ title: 'DB-TEST mid A', priority: 'normal' }, [], adminId, 'בדיקה');
    const b = await createTask({ title: 'DB-TEST mid B', priority: 'normal' }, [], adminId, 'בדיקה');
    const c = await createTask({ title: 'DB-TEST mid C', priority: 'normal' }, [], adminId, 'בדיקה');
    for (const t of [a, b, c]) await setTaskPrimaryAssignee(t.id, { kind: 'user', id: adminId }, adminId);
    await reorderWorkItemWithinLane('task', a.id, null); // a -> 0
    await reorderWorkItemWithinLane('task', b.id, null); // b -> 1 (after a)
    expect(await reorderWorkItemWithinLane('task', c.id, b.id)).toBe('moved'); // c between a and b
    const rows = await tx.query<{ id: string; sort_index: string }>(
      `select id, sort_index from public.tasks where id = any($1::uuid[]) order by sort_index asc`,
      [[a.id, b.id, c.id]],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([a.id, c.id, b.id]);
  });
});
