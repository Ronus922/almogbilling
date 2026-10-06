/**
 * Pure decision logic for the Bllink sync — no DB, no env, no 'server-only', so
 * it is unit-tested in isolation (tests/sync-decision.test.ts) and shared by
 * the route handler and the dashboard.
 *
 * A sync moves through five stages, each of which can fail on its own:
 *   scrape    → billing's own Bllink scrape, run on demand ("סנכרן עכשיו" only)
 *   stale     → billing's newest scrape is from today
 *               (BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS, strict, no default)
 *   guard     → completeness + consistency checks on the snapshot, BEFORE the write
 *   pull      → reading the snapshot / writing it into public.debtors
 *   reconcile → AFTER the write: the sums now in debtors, per category, equal the
 *               report's (reconcile.ts). The only stage that can fail once data
 *               has been written — its message says so.
 * The stage is persisted on sync_runs.error_stage and shown to the user; the
 * HTTP status tells the two families apart (upstream broke vs. data rejected).
 *
 * Until 26/09/2026 the snapshot came from the CRM (almog), and until its
 * teardown on 06/10/2026 the CRM was compared after the write as a witness.
 * Both are gone: billing's own scrape is the only source.
 */

export type SyncStage = 'scrape' | 'stale' | 'guard' | 'pull' | 'reconcile';

/**
 * BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS → hours, or null when unset / not a
 * positive number. There is deliberately NO default: with BLLINK_SOURCE=billing
 * the caller fails closed (stage 'stale', nothing written) until the limit is
 * configured, rather than copying a snapshot of unknown age.
 */
export function localFreshnessLimitHours(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export const SYNC_STAGE_LABELS: Record<SyncStage, string> = {
  scrape: 'סריקת בלינק',
  stale: 'רעננות הנתון במקור',
  guard: 'בדיקת שלמות הנתון',
  pull: 'משיכה וכתיבה',
  reconcile: 'התאמת הסכומים אחרי הכתיבה',
};

export class SyncStageError extends Error {
  readonly stage: SyncStage;
  readonly sourceRunAt: string | null;

  constructor(stage: SyncStage, message: string, sourceRunAt: string | null = null) {
    super(message);
    this.name = 'SyncStageError';
    this.stage = stage;
    this.sourceRunAt = sourceRunAt;
  }
}

/** 502 when the upstream/infrastructure failed, 409 when the data was rejected
 *  (stale / guard) or did not reconcile after the write (reconcile). */
export function stageHttpStatus(stage: SyncStage): 502 | 409 {
  return stage === 'scrape' || stage === 'pull' ? 502 : 409;
}

export type FreshnessOutcome =
  | { fresh: true; ageHours: number }
  | { fresh: false; ageHours: number | null; message: string };

/**
 * The snapshot must have been scraped within `maxAgeHours`. `runMaxAt` is when
 * Bllink was scraped (bllink_scrapes.finished_at, ISO). A missing timestamp is
 * treated as stale — we never copy data we cannot date.
 */
export function checkSnapshotFreshness(runMaxAt: string | null, maxAgeHours: number, now: number): FreshnessOutcome {
  if (!runMaxAt) {
    return { fresh: false, ageHours: null, message: 'הנתון במקור ללא תאריך סריקה — לא ניתן לאמת רעננות' };
  }
  const t = Date.parse(runMaxAt);
  if (Number.isNaN(t)) {
    return { fresh: false, ageHours: null, message: `הנתון במקור עם תאריך לא תקין: ${runMaxAt}` };
  }
  const ageHours = (now - t) / 36e5;
  if (ageHours > maxAgeHours) {
    return {
      fresh: false,
      ageHours,
      message: `הנתון במקור ישן: ${runMaxAt} (לפני ${Math.round(ageHours)} שעות, הסף ${maxAgeHours})`,
    };
  }
  return { fresh: true, ageHours };
}
