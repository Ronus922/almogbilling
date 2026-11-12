import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// The portal login log's paging (/admin/portal-log, 12/11/2026) against a REAL database.
// Before it the screen asked for the newest 200 rows and its counter was that 200, while the
// table held 398: rows past 200 could not be reached and no filter could see them. What is locked:
//   • pages are cut in SQL, 50 to a page, and together cover EVERY matching row exactly once —
//     including rows beyond the old 200 cap — in a stable newest-first order, even when many rows
//     share one timestamp (created_at alone is not unique; `id` breaks the tie);
//   • `total` is the number of rows the filters match across the whole log, on every page;
//   • a filter applies to the whole log, not to the page (a filter that matches 46 rows has
//     46 as its total and its page 1 is a full 46-row view, not a slice of the unfiltered page 1);
//   • a page past the end is an empty list with the true total (the screen sends the user to the last page);
//   • listPortalEvents — the apartment card's tab — still returns at most 200 rows, as before.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod. Every row is created with
// an id this file records and removed by exactly those ids (CLAUDE.md iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never as passed —
// scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
}));

const { pagePortalEvents, listPortalEvents } = await import('@/lib/db/portal/events');

const TOTAL = 230; // above the old 200 cap
const PAGE = 50;
// A phone prefix no real number and no other test uses: the phone filter is a digit-substring match.
const RUN = String(Date.now()).slice(-6);
const PHONE_DIGITS = `97253${RUN}`;
const APARTMENT = `PG${RUN}`;

let ids: string[] = [];
let timeline: Array<{ id: string; createdAt: Date }> = [];

beforeAll(async () => {
  if (!TEST_URL) return;
  pool = new Pool({ connectionString: TEST_URL, max: 2 });
  pool.on('error', () => undefined);
  // Ten rows share each timestamp (n / 10): the tie-break has to carry the order across page edges.
  // Every fifth is a `locked_out`, the rest `login_success`.
  const r = await pool.query<{ id: string; created_at: Date }>(
    `insert into public.portal_login_events (phone_e164, apartment_numbers, event_type, created_at)
     select '+${PHONE_DIGITS}' || lpad(n::text, 3, '0'),
            array[$1::text],
            case when n % 5 = 0 then 'locked_out' else 'login_success' end,
            now() - ((n / 10) * interval '1 hour')
       from generate_series(1, $2::int) as n
     returning id, created_at`,
    [APARTMENT, TOTAL],
  );
  ids = r.rows.map((x) => x.id);
  timeline = r.rows.map((x) => ({ id: x.id, createdAt: x.created_at }));
});

afterAll(async () => {
  if (!pool) return;
  if (ids.length) await pool.query('delete from public.portal_login_events where id = any($1::uuid[])', [ids]);
  await pool.end();
});

/** newest first, ties by id descending — what the SQL promises. */
function expectedOrder(): string[] {
  return [...timeline]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((x) => x.id);
}

d('pagePortalEvents', () => {
  const byPhone = { phone: PHONE_DIGITS };

  it('reports the true total on every page, 50 rows to a page', async () => {
    const sizes: number[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await pagePortalEvents(byPhone, page, PAGE);
      expect(r.total, `page ${page}`).toBe(TOTAL);
      sizes.push(r.events.length);
    }
    expect(sizes).toEqual([50, 50, 50, 50, 30]);
  });

  it('covers every row exactly once, newest first — including the rows beyond the old 200 cap', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) {
      seen.push(...(await pagePortalEvents(byPhone, page, PAGE)).events.map((e) => e.id));
    }
    expect(new Set(seen).size, 'no row twice').toBe(TOTAL);
    expect(seen, 'in the newest-first order with the id tie-break, across the page edges').toEqual(expectedOrder());
    // The rows the old screen could never show: positions 201–230.
    expect(seen.slice(200)).toEqual(expectedOrder().slice(200));
  });

  it('applies a filter to the whole log: the total and the pages are the filtered ones', async () => {
    const locked = { phone: PHONE_DIGITS, eventType: 'locked_out' as const };
    const want = TOTAL / 5; // every fifth row
    const p1 = await pagePortalEvents(locked, 1, 20);
    const p3 = await pagePortalEvents(locked, 3, 20);
    expect(p1.total).toBe(want);
    expect(p3.total).toBe(want);
    expect(p1.events).toHaveLength(20);
    expect(p3.events).toHaveLength(want - 40); // 46 rows: 20 + 20 + 6
    expect(new Set([...p1.events, ...p3.events].map((e) => e.event_type))).toEqual(new Set(['locked_out']));
  });

  it('a page past the end is empty, with the true total', async () => {
    const r = await pagePortalEvents(byPhone, 99, PAGE);
    expect(r.events).toEqual([]);
    expect(r.total).toBe(TOTAL);
  });

  it('an apartment filter and a date range filter the count as well as the rows', async () => {
    const apt = await pagePortalEvents({ apartment: APARTMENT }, 1, PAGE);
    expect(apt.total).toBe(TOTAL);
    // Every row is within the last ~24 hours: a range that ended years ago matches none of them.
    const none = await pagePortalEvents({ ...byPhone, from: '2001-01-01', to: '2001-01-02' }, 1, PAGE);
    expect(none).toEqual({ events: [], total: 0 });
  });

  it('keeps the owner-name join (a roster phone shows its name, an unknown one null)', async () => {
    const r = await pagePortalEvents(byPhone, 1, 5);
    expect(r.events.every((e) => e.owner_name === null)).toBe(true);
  });
});

d('listPortalEvents — the apartment card tab', () => {
  it('still returns the newest 200 and no more (the tab is not paged)', async () => {
    const rows = await listPortalEvents({ apartment: APARTMENT });
    expect(rows).toHaveLength(200);
    expect(rows.map((r) => r.id)).toEqual(expectedOrder().slice(0, 200));
  });
});
