import { describe, it, expect, vi } from 'vitest';
import { BLLINK_SCRAPE_LOCK_KEY, resolveScrapeConnection, tryAcquireScrapeLock } from '@/lib/sync/scrapeLock';

// One Bllink scrape at a time (27/09/2026). The scraper takes this lock on its
// own connection before it opens a bllink_scrapes row; a refused lock means
// another scrape is already producing that snapshot, so the run must skip
// quietly — exit 0, no row, no OnFailure alert.
describe('tryAcquireScrapeLock', () => {
  it('asks pg_try_advisory_lock for the shared key and reports success', async () => {
    const db = { query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ ok: true }] })) };
    await expect(tryAcquireScrapeLock(db)).resolves.toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/pg_try_advisory_lock\(\$1\)/);
    // try_ and not pg_advisory_lock: a scraper must never QUEUE behind another.
    expect(db.query.mock.calls[0][0]).not.toMatch(/pg_advisory_lock\(/);
    expect(db.query.mock.calls[0][1]).toEqual([BLLINK_SCRAPE_LOCK_KEY]);
  });

  it('reports failure when the lock is held elsewhere', async () => {
    const db = { query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ ok: false }] })) };
    await expect(tryAcquireScrapeLock(db)).resolves.toBe(false);
  });

  it('treats a missing / null answer as NOT acquired (fail-closed)', async () => {
    for (const rows of [[], [{ ok: null }]]) {
      const db = { query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows })) };
      await expect(tryAcquireScrapeLock(db)).resolves.toBe(false);
    }
  });

  it('keeps the key stable — both callers hard-code the same number', () => {
    expect(BLLINK_SCRAPE_LOCK_KEY).toBe(8_112_026_001);
  });
});

// WHERE the lock may live. Found the hard way on 27/09/2026: billing's
// DATABASE_URL is Supavisor in transaction pooling mode, and a session advisory
// lock taken through it stayed on an idle pooled SERVER connection after the
// scraper exited — the next two scrapes skipped, and the 05:30 timer would have
// been starved the following morning while every run reported success.
describe('resolveScrapeConnection', () => {
  it('prefers DIRECT_URL and only then calls the lock authoritative', () => {
    expect(
      resolveScrapeConnection({
        DIRECT_URL: 'postgresql://u@localhost:5432/db',
        DATABASE_URL: 'postgresql://u@localhost:6543/db',
      }),
    ).toEqual({ connectionString: 'postgresql://u@localhost:5432/db', lockable: true });
  });

  it('falls back to the pooled URL WITHOUT locking — a stuck lock is worse than a double scrape', () => {
    expect(resolveScrapeConnection({ DATABASE_URL: 'postgresql://u@localhost:6543/db' })).toEqual({
      connectionString: 'postgresql://u@localhost:6543/db',
      lockable: false,
    });
  });

  it('ignores a blank DIRECT_URL rather than connecting to nothing', () => {
    expect(
      resolveScrapeConnection({ DIRECT_URL: '   ', DATABASE_URL: 'postgresql://u@localhost:6543/db' }),
    ).toMatchObject({ connectionString: 'postgresql://u@localhost:6543/db', lockable: false });
  });

  it('throws when neither is set — there is nothing to connect to', () => {
    expect(() => resolveScrapeConnection({})).toThrow(/DIRECT_URL/);
  });
});
