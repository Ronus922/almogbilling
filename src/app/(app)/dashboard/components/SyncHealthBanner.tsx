import { AlertTriangle } from 'lucide-react';
import type { SyncHealth } from '@/lib/dashboard/syncHealth';
import { SYNC_STAGE_LABELS } from '@/lib/sync/decision';
import { formatStamp } from '@/lib/dashboard/formatStamp';
import {
  SYNC_FAILURE_ADVICE,
  SYNC_FAILURE_TITLE,
  SYNC_LAST_UPDATE_LABEL,
  SYNC_LAST_UPDATE_NONE,
  SYNC_TECH_DETAILS_LABEL,
} from '@/lib/dashboard/syncCopy';

/**
 * Persistent red banner at the top of the dashboard (every user, no dismiss)
 * when Bllink data cannot be trusted: the last sync failed, the last successful
 * sync's source data is older than the freshness threshold, or no sync ever
 * succeeded. Renders nothing when health is 'ok'. Tone per DESIGN.md §8
 * (danger banner: border-red-200 bg-red-50 text-red-900).
 *
 * Wording (11/09/2026): three fixed lines for everyone — title, "עדכון אחרון:
 * <source_run_at of the last success>", and what to do. The user is not told
 * the stage, the trigger source or the CRM's error text; a failed run and a
 * stale snapshot read the same. Admins get a closed-by-default "פרטים טכניים"
 * disclosure with all of that; for anyone else it is not in the HTML at all.
 */
export function SyncHealthBanner({ health, isAdmin }: { health: SyncHealth; isAdmin: boolean }) {
  if (health.state === 'ok') return null;

  const lastGood = health.state === 'never' ? null : health.sourceRunAt;

  // Technical lines — rendered only for admins, inside <details>.
  const techLines: string[] = [];
  // The CRM's error text mixes Hebrew with English selectors/stack lines —
  // rendered as its own block so each line resolves its own direction.
  let techMessage: string | null = null;
  if (health.state === 'failed') {
    const r = health.run;
    techLines.push(`נכשל ב-${formatStamp(r.finishedAt ?? r.startedAt)} (${r.triggerSource === 'cron' ? 'סנכרון אוטומטי' : 'הפעלה ידנית'})`);
    techLines.push(`שלב: ${r.stage ? SYNC_STAGE_LABELS[r.stage] : 'לא ידוע'}`);
    if (r.message) techMessage = r.message;
  } else if (health.state === 'stale') {
    techLines.push(`הסנכרון המוצלח האחרון קרא נתון בן ${Math.round(health.ageHours)} שעות — מעל הסף של ${health.maxAgeHours} שעות`);
  } else {
    techLines.push('לא נרשם סנכרון מוצלח מעולם');
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/70 text-[#e5484d]">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="font-bold">{SYNC_FAILURE_TITLE}</div>
        <div className="break-words">
          {SYNC_LAST_UPDATE_LABEL}{' '}
          {lastGood
            ? <span className="font-num tabular-nums">{formatStamp(lastGood)}</span>
            : <span>{SYNC_LAST_UPDATE_NONE}</span>}
        </div>
        <div className="break-words">{SYNC_FAILURE_ADVICE}</div>
        {isAdmin && (
          <details className="group mt-1">
            <summary className="inline-flex min-h-[44px] cursor-pointer list-none items-center text-xs font-semibold underline underline-offset-2 hover:opacity-80 [&::-webkit-details-marker]:hidden">
              {SYNC_TECH_DETAILS_LABEL}
            </summary>
            <div className="flex flex-col gap-1 rounded-md bg-white/60 px-3 py-2 text-xs">
              {techLines.map((l) => (
                <div key={l} className="break-words">{l}</div>
              ))}
              {techMessage && (
                <div dir="auto" className="whitespace-pre-wrap break-words [unicode-bidi:plaintext]">
                  <span className="font-semibold">הודעה: </span>{techMessage}
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
