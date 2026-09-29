import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { readDebtorsAfterWrite, type ReconcileRow } from '@/lib/sync/reconcileRead';
import { reconcileAfterWrite, snapshotTotals } from '@/lib/sync/reconcile';

// The post-write reconciliation against a REAL public.debtors — the SQL in
// reconcileRead.ts exercised end to end, with a simulated gap. Runs ONLY when a
// throwaway test DB is wired (WA_TEST_DATABASE_URL, same switch as the other
// DB-backed suites) — never production.
//
// readDebtorsAfterWrite aggregates the WHOLE debtors table, so these
// assertions are only meaningful when the table holds this file's fixtures and
// nothing else. Everything therefore runs inside a transaction that is ALWAYS
// rolled back: the emptying, the fixtures and the assertions all live and die
// inside it, so the suite is hermetic on a seeded database too and no row it
// touches outlives it (iron rule 12 — the same shape as
// tests/import-clearing-db.test.ts).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never
// as passed — scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
let tx: PoolClient;
/** apartment_number → debtors.id of the rows the CURRENT transaction inserted. */
const ids = new Map<string, string>();

const A1 = 'RC-A1';
const A2 = 'RC-A2';
const B1 = 'RC-B1'; // archived
const Z1 = 'RC-Z1'; // non-archived, not in the report
const N1 = 'RC-N1'; // never inserted

function row(apartment_number: string, management_fees: number, hot_water_debt: number): ReconcileRow {
  return { apartment_number, management_fees, hot_water_debt };
}

async function setDebt(apt: string, management: number, hotWater: number, archived = false): Promise<void> {
  const id = ids.get(apt);
  if (!id) throw new Error(`fixture ${apt} not inserted`);
  await tx.query(
    `update public.debtors
        set management_fees = $2::numeric, hot_water_debt = $3::numeric,
            total_debt = $2::numeric + $3::numeric, is_archived = $4::boolean
      where id = $1`,
    [id, management, hotWater, archived],
  );
}

d('readDebtorsAfterWrite — the real SQL against a throwaway debtors table', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  // The state a correct merge leaves: report rows written, Z1 zeroed, B1
  // archived and in the report — in a table that holds nothing else, so the
  // whole-table totals below mean what they say. Rolled back in afterEach.
  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
    await tx.query('delete from public.debtors');
    ids.clear();
    for (const apt of [A1, A2, B1, Z1]) {
      const r = await tx.query<{ id: string }>(
        `insert into public.debtors (apartment_number) values ($1) returning id`,
        [apt],
      );
      ids.set(apt, r.rows[0].id);
    }
    await setDebt(A1, 100, 10);
    await setDebt(A2, 200, 20);
    await setDebt(B1, 176, 251, true);
    await setDebt(Z1, 0, 0);
  });

  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  const report = [row(A1, 100, 10), row(A2, 200, 20), row(B1, 176, 251)];

  it('a clean merge reconciles: sums include the archived-but-reported row, all lists empty', async () => {
    const after = await readDebtorsAfterWrite(tx, report);
    expect(after.totals).toEqual({ management: 476, hotWater: 281 });
    expect(after.leftovers).toEqual([]);
    expect(after.unwritten).toEqual([]);
    expect(after.mismatched).toEqual([]);
    expect(after.archivedLeftovers).toEqual([]);
    expect(reconcileAfterWrite(snapshotTotals(report), after)).toEqual({ ok: true, warning: null });
  });

  it('SIMULATED GAP (the 27/09 case): a non-archived apartment the report dropped still carries debt → fails, named', async () => {
    await setDebt(Z1, 9810, 190); // paid in Bllink, not zeroed here
    const after = await readDebtorsAfterWrite(tx, report);
    expect(after.leftovers).toEqual([Z1]);
    expect(after.totals).toEqual({ management: 476 + 9810, hotWater: 281 + 190 });
    const r = reconcileAfterWrite(snapshotTotals(report), after);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(Z1);
      expect(r.message).toContain('פער 9,810.00 ₪');
    }
  });

  it('a report apartment written with a different amount is listed even when only agorot differ', async () => {
    await setDebt(A2, 200.01, 20);
    const after = await readDebtorsAfterWrite(tx, report);
    expect(after.mismatched).toEqual([A2]);
    expect(reconcileAfterWrite(snapshotTotals(report), after).ok).toBe(false);
  });

  it('a report apartment with no debtors row is "unwritten"', async () => {
    const after = await readDebtorsAfterWrite(tx, [...report, row(N1, 50, 5)]);
    expect(after.unwritten).toEqual([N1]);
    const r = reconcileAfterWrite(snapshotTotals([...report, row(N1, 50, 5)]), after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(N1);
  });

  it('an archived apartment the report dropped is a warning, outside the totals', async () => {
    const withoutB1 = [row(A1, 100, 10), row(A2, 200, 20)];
    const after = await readDebtorsAfterWrite(tx, withoutB1);
    expect(after.archivedLeftovers).toEqual([B1]);
    expect(after.leftovers).toEqual([]);
    expect(after.totals).toEqual({ management: 300, hotWater: 30 });
    const r = reconcileAfterWrite(snapshotTotals(withoutB1), after);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain(B1);
  });

  it('an empty report expects every non-archived apartment at zero', async () => {
    const after = await readDebtorsAfterWrite(tx, []);
    expect(after.leftovers).toEqual([A1, A2]);
    expect(after.totals).toEqual({ management: 300, hotWater: 30 });
    expect(reconcileAfterWrite(snapshotTotals([]), after).ok).toBe(false);
  });
});
