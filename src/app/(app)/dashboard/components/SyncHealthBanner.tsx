import { AlertTriangle } from 'lucide-react';
import type { SyncHealth } from '@/lib/dashboard/syncHealth';
import { SYNC_STAGE_LABELS } from '@/lib/sync/decision';
import { formatStamp } from '@/lib/dashboard/formatStamp';

/**
 * Persistent red banner at the top of the dashboard (every user, no dismiss)
 * when Bllink data cannot be trusted: the last sync failed, the last successful
 * sync's source data is older than the freshness threshold, or no sync ever
 * succeeded. Renders nothing when health is 'ok'. Tone per DESIGN.md §8
 * (danger banner: border-red-200 bg-red-50 text-red-900).
 */
export function SyncHealthBanner({ health }: { health: SyncHealth }) {
  if (health.state === 'ok') return null;

  const correctAsOf = health.state === 'never' ? null : health.sourceRunAt;

  let title: string;
  const lines: string[] = [];
  // The CRM's error text mixes Hebrew with English selectors/stack lines —
  // rendered as its own block so each line resolves its own direction.
  let detail: string | null = null;
  if (health.state === 'failed') {
    const r = health.run;
    title = 'סנכרון בלינק נכשל — הנתונים המוצגים אינם מעודכנים';
    lines.push(`נכשל ב-${formatStamp(r.finishedAt ?? r.startedAt)} (${r.triggerSource === 'cron' ? 'סנכרון אוטומטי' : 'הפעלה ידנית'})`);
    lines.push(`שלב: ${r.stage ? SYNC_STAGE_LABELS[r.stage] : 'לא ידוע'}`);
    if (r.message) detail = r.message;
  } else if (health.state === 'stale') {
    title = 'נתוני בלינק אינם מעודכנים';
    lines.push(`הסנכרון המוצלח האחרון קרא נתון בן ${Math.round(health.ageHours)} שעות — מעל הסף של ${health.maxAgeHours} שעות`);
  } else {
    title = 'לא בוצע סנכרון מוצלח מול בלינק';
    lines.push('החובות המוצגים לא אומתו מול בלינק מעולם');
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
        <div className="font-bold">{title}</div>
        {lines.map((l) => (
          <div key={l} className="break-words">{l}</div>
        ))}
        {detail && (
          <div
            dir="auto"
            className="whitespace-pre-wrap break-words rounded-md bg-white/60 px-3 py-2 text-xs text-red-900 [unicode-bidi:plaintext]"
          >
            <span className="font-semibold">הודעה: </span>{detail}
          </div>
        )}
        <div className="font-semibold">
          הנתונים המוצגים נכונים ל-
          {correctAsOf
            ? <span className="font-num tabular-nums">{formatStamp(correctAsOf)}</span>
            : <span>תאריך לא ידוע</span>}
        </div>
      </div>
    </div>
  );
}
