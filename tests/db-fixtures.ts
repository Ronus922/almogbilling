import type { Pool } from 'pg';

/**
 * The actor id every DB-backed suite writes as: the admin `scripts/e2e/seed.sh`
 * creates. Looking it up inline used to read `admin.rows[0]!.id` and, on a
 * database that was wired but never seeded, died as
 * `Cannot read properties of undefined (reading 'id')` — a `beforeAll` crash
 * that looks like a broken query instead of a missing fixture, and that then
 * reported the whole file as skipped rather than failed (29/09/2026).
 *
 * The suites are gated on WA_TEST_DATABASE_URL being set, not on the database
 * behind it being usable, so this is where that second assumption is checked.
 */
export async function requireSeededAdmin(pool: Pick<Pool, 'query'>): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `select id from public.users where username = 'e2e-admin'`,
  );
  const id = r.rows[0]?.id;
  if (!id) {
    throw new Error(
      'WA_TEST_DATABASE_URL points at a database with no e2e-admin user. ' +
        'This suite needs the e2e fixtures: run `DATABASE_URL="$WA_TEST_DATABASE_URL" bash scripts/e2e/seed.sh` ' +
        '(idempotent) against that database, or unset WA_TEST_DATABASE_URL to skip the DB-backed suites.',
    );
  }
  return id;
}
