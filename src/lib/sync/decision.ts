/**
 * Pure decision logic for the Bllink sync — no DB, no env, no 'server-only', so
 * it is unit-tested in isolation (tests/sync-decision.test.ts) and shared by
 * the route handler and the dashboard.
 *
 * A sync moves through four stages, each of which can fail on its own:
 *   scrape → the CRM re-scrapes Bllink (POST CRM_SYNC_URL)
 *   stale  → the snapshot the CRM holds is recent enough to copy
 *   guard  → completeness + reconciliation checks on the snapshot
 *   pull   → fetching the snapshot / writing it into public.debtors
 * The stage is persisted on sync_runs.error_stage and shown to the user; the
 * HTTP status tells the two families apart (upstream broke vs. data rejected).
 */
import { z } from 'zod';

export type SyncStage = 'scrape' | 'stale' | 'guard' | 'pull';

export const SYNC_STAGE_LABELS: Record<SyncStage, string> = {
  scrape: 'סריקת בלינק ב-CRM',
  stale: 'רעננות הנתון במקור',
  guard: 'בדיקת שלמות הנתון',
  pull: 'משיכה וכתיבה',
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

/** 502 when the upstream/infrastructure failed, 409 when the data was rejected. */
export function stageHttpStatus(stage: SyncStage): 502 | 409 {
  return stage === 'scrape' || stage === 'pull' ? 502 : 409;
}

// What the CRM's /api/admin/jobs/syncBllinkDebt answers. It returns HTTP 200
// with ok:true even when the download failed — the truth is in result.*.
const crmScrapeResponseSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  result: z
    .object({
      downloaded: z.boolean(),
      parsed: z.number().optional(),
      errors: z.array(z.string()).default([]),
    })
    .optional(),
});

export type CrmScrapeOutcome = { ok: true; parsed: number } | { ok: false; message: string };

/**
 * Interprets the CRM's scrape response. Anything other than "HTTP 2xx, ok,
 * downloaded === true, no errors" is a scrape failure carrying the CRM's own
 * error text, in full, so the sync_runs row and the banner say what broke.
 */
export function parseCrmScrapeResponse(status: number, body: unknown): CrmScrapeOutcome {
  if (status < 200 || status >= 300) {
    const detail = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : '';
    return { ok: false, message: `ה-CRM החזיר HTTP ${status}${detail ? ` (${detail})` : ''}` };
  }
  const parsed = crmScrapeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: 'תשובת ה-CRM אינה בפורמט הצפוי (ללא result.downloaded)' };
  }
  const data = parsed.data;
  if (data.ok === false) {
    return { ok: false, message: `ה-CRM דחה את הבקשה: ${data.error ?? 'ללא פירוט'}` };
  }
  if (!data.result) {
    return { ok: false, message: 'תשובת ה-CRM ללא result — הסריקה לא רצה' };
  }
  if (data.result.downloaded !== true || data.result.errors.length > 0) {
    const errs = data.result.errors.length > 0 ? data.result.errors.join(' | ') : 'downloaded=false ללא פירוט';
    return { ok: false, message: `הסריקה בבלינק נכשלה: ${errs}` };
  }
  return { ok: true, parsed: data.result.parsed ?? 0 };
}

export type FreshnessOutcome =
  | { fresh: true; ageHours: number }
  | { fresh: false; ageHours: number | null; message: string };

/**
 * The snapshot the CRM holds must have been scraped within `maxAgeHours`.
 * `runMaxAt` is the newest last_import_at in the snapshot (ISO string from
 * PostgREST). A missing timestamp is treated as stale — we never copy data we
 * cannot date.
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
