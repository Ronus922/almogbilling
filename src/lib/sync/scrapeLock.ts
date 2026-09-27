// One Bllink scrape at a time — a Postgres session advisory lock.
//
// Two paths can start a scrape: billing-bllink-scrape.timer (05:30) and, since
// 27/09/2026, the dashboard's "סנכרן עכשיו" (which starts the same systemd
// unit). systemd itself coalesces a start request for a unit that is already
// running, but it cannot see a scrape somebody launched by hand
// (`tsx scripts/bllink-scrape.ts`) — and two Playwright logins into Bllink at
// the same moment is exactly the state that produced half-written snapshots.
//
// A SESSION lock (not a row, not a file) because it is released by Postgres the
// instant the connection dies: an OOM-killed or SIGKILLed scraper cannot leave
// a lock behind, which is precisely how a status-column "lock" gets stuck.
//
// The key is an arbitrary but FIXED bigint — a name would be hashed to one
// anyway, and a literal keeps both callers honest about sharing it.
export const BLLINK_SCRAPE_LOCK_KEY = 8_112_026_001;

/** The narrowest shape of a pg client this needs — so a test can pass a fake. */
export type AdvisoryLockQuerier = {
  query(sql: string, values?: unknown[]): Promise<{ rows: { ok?: boolean | null }[] }>;
};

/**
 * Tries to take the scrape lock on THIS connection. `false` = another scrape
 * holds it, and the caller must exit without touching bllink_scrapes — not
 * wait, not retry: the other run is producing the very snapshot we wanted.
 *
 * Never throws for a refused lock; a real DB error still propagates.
 */
export async function tryAcquireScrapeLock(db: AdvisoryLockQuerier): Promise<boolean> {
  const { rows } = await db.query('select pg_try_advisory_lock($1) as ok', [BLLINK_SCRAPE_LOCK_KEY]);
  return rows[0]?.ok === true;
}
