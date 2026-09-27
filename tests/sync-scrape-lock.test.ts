import { describe, it, expect, vi } from 'vitest';
import { BLLINK_SCRAPE_LOCK_KEY, tryAcquireScrapeLock } from '@/lib/sync/scrapeLock';

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
