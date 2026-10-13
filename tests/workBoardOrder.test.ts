import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Per-user, per-module board customization (13/10/2026, "התאמת לוח" decision
// 2) against a REAL database (WA_TEST_DATABASE_URL, a throwaway — never
// production). Every test runs inside a transaction that is ALWAYS rolled
// back (iron rule 12; same shape as tests/workItemsPrimaryAssignee.test.ts).
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

const { getWorkBoardOrder, setWorkBoardOrder } = await import('@/lib/db/workBoardOrder');

// Fake-but-valid-shaped uuids — employee_ids carries no FK (the migration's
// own point: a stale id is dropped at render time, not rejected at write time).
const EMP_A = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const EMP_B = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const EMP_C = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

d('getWorkBoardOrder / setWorkBoardOrder', () => {
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

  it('no row saved yet → null, the caller’s cue to fall back to the default algorithm', async () => {
    expect(await getWorkBoardOrder(adminId, 'issue')).toBeNull();
  });

  it('saves and reloads the exact order, for its own kind', async () => {
    await setWorkBoardOrder(adminId, 'issue', [EMP_B, EMP_A]);
    expect(await getWorkBoardOrder(adminId, 'issue')).toEqual([EMP_B, EMP_A]);
  });

  it('issue and task orders are independent for the same user', async () => {
    await setWorkBoardOrder(adminId, 'issue', [EMP_A]);
    expect(await getWorkBoardOrder(adminId, 'task')).toBeNull();
  });

  it('an empty array is a deliberate "hide every lane" choice, distinct from no row at all', async () => {
    await setWorkBoardOrder(adminId, 'task', []);
    expect(await getWorkBoardOrder(adminId, 'task')).toEqual([]);
  });

  it('saving again fully replaces the previous order — upsert, not append', async () => {
    await setWorkBoardOrder(adminId, 'issue', [EMP_A, EMP_B, EMP_C]);
    await setWorkBoardOrder(adminId, 'issue', [EMP_C, EMP_A]);
    expect(await getWorkBoardOrder(adminId, 'issue')).toEqual([EMP_C, EMP_A]);
  });

  it('rejects a kind outside issue|task at the database level (defense in depth below the API’s own validation)', async () => {
    await expect(
      tx.query(
        `insert into public.user_work_board_order (user_id, kind, employee_ids) values ($1, 'supplier', '{}')`,
        [adminId],
      ),
    ).rejects.toThrow();
  });
});
