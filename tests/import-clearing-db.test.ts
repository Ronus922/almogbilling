import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { clearDebtorsNotInImport } from '@/lib/import/clearing';

// The merge-mode clearing against a REAL public.debtors: the SQL in
// lib/import/clearing.ts end to end. Runs ONLY when a throwaway test DB is
// wired (WA_TEST_DATABASE_URL, the same switch as the other DB-backed suites)
// — never production.
//
// Every fixture lives inside a transaction that is ALWAYS rolled back (iron
// rule 12: nothing this file writes can outlive it, and the clearing's own
// "every non-archived row" case cannot reach rows another suite seeded).
//
// What it pins down — the bug of 29/09/2026: an apartment that leaves the
// Bllink report had its amounts zeroed but kept `details`, so a settled
// apartment still showed the old "פרטים" text. The assertions cover every
// field the import owns, so the next field added to the import cannot be
// forgotten here silently.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;
let tx: PoolClient;

const GONE = 'IC-GONE'; // not in the import
const KEPT = 'IC-KEPT'; // in the import
const ARCH = 'IC-ARCH'; // archived, not in the import

interface Row {
  total_debt: string;
  management_fees: string;
  hot_water_debt: string;
  special_debt: string;
  monthly_debt: string | null;
  details: string | null;
  notes: string | null;
  phone_tenant: string | null;
  next_action_description: string | null;
}

/** A debtor with a live debt and every import + manual text field filled. */
async function seed(apartment: string, archived: boolean): Promise<void> {
  await tx.query(
    `insert into public.debtors
       (apartment_number, total_debt, management_fees, hot_water_debt, special_debt,
        monthly_debt, details, is_archived, notes, phone_tenant, next_action_description)
     values ($1, 1000, 810, 190, 0, '1/26 - 9/26', 'מים חמים 05-06/25', $2,
             'הערה ידנית', '0501234567', 'לחזור אליו')`,
    [apartment, archived],
  );
}

async function read(apartment: string): Promise<Row> {
  const r = await tx.query<Row>(
    `select total_debt::text, management_fees::text, hot_water_debt::text, special_debt::text,
            monthly_debt, details, notes, phone_tenant, next_action_description
       from public.debtors where apartment_number = $1`,
    [apartment],
  );
  return r.rows[0];
}

const OWING = {
  total_debt: '1000.00', management_fees: '810.00', hot_water_debt: '190.00', special_debt: '0.00',
  monthly_debt: '1/26 - 9/26', details: 'מים חמים 05-06/25',
};
const MANUAL = { notes: 'הערה ידנית', phone_tenant: '0501234567', next_action_description: 'לחזור אליו' };

d('clearDebtorsNotInImport — the real SQL against a throwaway debtors table', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
    await seed(GONE, false);
    await seed(KEPT, false);
    await seed(ARCH, true);
  });

  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  it('clears every import field of a non-archived apartment the import did not bring — text included', async () => {
    await clearDebtorsNotInImport(tx, [KEPT]);
    expect(await read(GONE)).toMatchObject({
      total_debt: '0.00', management_fees: '0.00', hot_water_debt: '0.00', special_debt: '0.00',
      monthly_debt: null,
      details: null, // the 29/09/2026 bug: this stayed behind
    });
  });

  it('never touches the manual fields of the apartment it clears', async () => {
    await clearDebtorsNotInImport(tx, [KEPT]);
    expect(await read(GONE)).toMatchObject(MANUAL);
  });

  it('leaves an apartment that IS in the import alone', async () => {
    await clearDebtorsNotInImport(tx, [KEPT]);
    expect(await read(KEPT)).toMatchObject({ ...OWING, ...MANUAL });
  });

  it('leaves an archived apartment alone even when the import dropped it', async () => {
    await clearDebtorsNotInImport(tx, [KEPT]);
    expect(await read(ARCH)).toMatchObject({ ...OWING, ...MANUAL });
  });

  it('clears every non-archived apartment when the import brought none', async () => {
    await clearDebtorsNotInImport(tx, []);
    for (const apt of [GONE, KEPT]) {
      expect(await read(apt), apt).toMatchObject({ total_debt: '0.00', monthly_debt: null, details: null });
    }
    expect(await read(ARCH)).toMatchObject(OWING);
  });
});
