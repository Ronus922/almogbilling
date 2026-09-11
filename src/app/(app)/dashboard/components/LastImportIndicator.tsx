'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarSync, History, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { computeSeverity, type Severity } from '@/lib/dashboard/syncStatus';
import { formatStamp } from '@/lib/dashboard/formatStamp';
import { SYNC_FAILURE_TITLE } from '@/lib/dashboard/syncCopy';
import type { SyncRunSummary } from '@/lib/dashboard/syncHealth';
import { SYNC_STAGE_LABELS, type SyncStage } from '@/lib/sync/decision';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { SyncHistorySheet } from './SyncHistorySheet';

const sevStyles: Record<Severity, { wrap: string; iconBg: string; iconFg: string }> = {
  ok:     { wrap: 'bg-white border-line text-ink',                       iconBg: 'bg-brand-soft', iconFg: 'text-brand' },
  yellow: { wrap: 'bg-[#fff6e6] border-[#e08700]/30 text-[#945700]',     iconBg: 'bg-white/70',   iconFg: 'text-[#e08700]' },
  red:    { wrap: 'bg-[#feefef] border-[#e5484d]/30 text-[#b01b20]',     iconBg: 'bg-white/70',   iconFg: 'text-[#e5484d]' },
};

interface SyncResponse {
  ok?: boolean;
  stage?: SyncStage | 'auth' | 'rate_limit' | 'done';
  message?: string;
  sourceRunAt?: string | null;
  error?: string;
}

interface StatusResponse {
  lastRun: SyncRunSummary | null;
  lastSuccess: SyncRunSummary | null;
  sourceRunAt: string | null;
}

/**
 * Dashboard freshness indicator (DESIGN.md §5b). The primary line is the
 * SOURCE time — when Bllink was actually scraped (sync_runs.source_run_at of
 * the last successful sync) — never the time the data was copied here. The
 * secondary line is the last sync attempt and how it ended.
 */
export function LastImportIndicator({
  sourceRunAt,
  lastRun,
  maxAgeHours,
  canSync,
  isAdmin,
}: {
  sourceRunAt: Date | null;
  lastRun: SyncRunSummary | null;
  maxAgeHours: number;
  canSync: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Held in state so a finished sync updates the card immediately, before the
  // background router.refresh() lands; re-derived when the server props change
  // (the React "adjust state on prop change" pattern — no effect needed).
  const [sourceAt, setSourceAt] = useState<Date | null>(sourceRunAt);
  const [last, setLast] = useState<SyncRunSummary | null>(lastRun);
  const [seenProps, setSeenProps] = useState({ sourceRunAt, lastRun });
  if (seenProps.sourceRunAt !== sourceRunAt || seenProps.lastRun !== lastRun) {
    setSeenProps({ sourceRunAt, lastRun });
    setSourceAt(sourceRunAt);
    setLast(lastRun);
  }

  // computeSeverity reads Date.now(), which differs between SSR and hydration —
  // compute it only after mount and render the calm 'ok' state until then, so the
  // first client paint matches the server markup (avoids React #418).
  const mounted = useHasMounted();
  const severity: Severity = mounted ? computeSeverity(sourceAt, Date.now(), maxAgeHours) : 'ok';
  const styles = sevStyles[severity];

  const subline =
    severity === 'red'
      ? sourceAt
        ? `נתוני בלינק ישנים מ-${maxAgeHours} שעות — מומלץ לסנכרן`
        : 'לא בוצע סנכרון מוצלח מעולם'
      : severity === 'yellow'
      ? 'נתוני בלינק לא רועננו מעל 24 שעות'
      : null;

  async function refreshStatus() {
    const s = await fetch('/api/sync/status', { credentials: 'include' });
    if (!s.ok) return;
    const j = (await s.json()) as StatusResponse;
    setSourceAt(j.sourceRunAt ? new Date(j.sourceRunAt) : null);
    setLast(j.lastRun);
  }

  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/bllink', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as SyncResponse | null;
      if (!res.ok || !body?.ok) {
        // Same first line as the banner, nothing technical — the stage and the
        // CRM's message are in sync_runs and in the admin history panel.
        toast.error(SYNC_FAILURE_TITLE, { duration: 12_000 });
      } else {
        toast.success(body.message ?? 'הסנכרון הושלם');
      }
      // Either way the card and the banner must reflect the run that just ended.
      try { await refreshStatus(); } catch { /* router.refresh() below re-reads the server state */ }
      startTransition(() => router.refresh());
    } catch (e) {
      toast.error(SYNC_FAILURE_TITLE, { duration: 12_000 });
    } finally {
      setSyncing(false);
    }
  }

  const showWarning = severity !== 'ok';
  const lastLabel = last
    ? last.status === 'success'
      ? 'הצליח'
      : last.status === 'error'
        ? `נכשל${last.stage ? ` — ${SYNC_STAGE_LABELS[last.stage]}` : ''}`
        : 'רץ עכשיו'
    : null;

  return (
    <>
      <div className={cn('flex flex-col gap-3 rounded-2xl border px-5 py-3.5 shadow-soft-xs md:flex-row md:items-center md:justify-between', styles.wrap)}>
        <div className="flex items-center gap-3">
          <div className={cn('grid h-10 w-10 place-items-center rounded-xl', styles.iconBg, styles.iconFg)}>
            <CalendarSync className="h-5 w-5" aria-hidden />
          </div>
          <div className="leading-tight">
            {/* Primary — when Bllink was actually scraped (drives the severity) */}
            <div className="font-semibold">
              נתוני בלינק נכונים ל-
              {sourceAt
                ? <span className="font-num font-medium tabular-nums">{formatStamp(sourceAt)}</span>
                : <span className="opacity-80">טרם בוצע סנכרון מוצלח</span>}
            </div>
            {/* Secondary — the last attempt and how it ended */}
            <div className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-2">
              <RefreshCw className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
              <span>
                סנכרון אחרון:{' '}
                {last
                  ? (
                    <>
                      <span className="font-num tabular-nums">{formatStamp(last.finishedAt ?? last.startedAt)}</span>
                      {' · '}
                      <span className={cn(last.status === 'error' && 'font-semibold text-[#b01b20]')}>{lastLabel}</span>
                    </>
                  )
                  : <span className="text-ink-3">טרם בוצע סנכרון</span>}
              </span>
            </div>
            {subline && <div className="mt-0.5 text-xs opacity-80">{subline}</div>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSync && (
            <Button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="h-9 gap-2 rounded-lg bg-gradient-to-l from-[#16a34a] to-[#0c7a37] px-4 text-sm font-bold text-white shadow-[0_4px_14px_rgba(22,163,74,0.3)] hover:brightness-105"
            >
              <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
              <span>{syncing ? 'מסנכרן…' : 'סנכרן עכשיו'}</span>
            </Button>
          )}
          {isAdmin && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              className="h-9 gap-2 rounded-lg px-4 text-sm"
            >
              <History className="h-4 w-4" />
              <span>היסטוריה</span>
            </Button>
          )}
          {canSync && showWarning && (
            <Button
              type="button"
              onClick={() => router.push('/import')}
              className="h-9 gap-2 rounded-lg bg-brand px-4 text-sm font-bold text-white hover:bg-brand-dark"
            >
              <Upload className="h-4 w-4" />
              <span>ייבוא נתונים</span>
            </Button>
          )}
        </div>
      </div>
      {isAdmin && <SyncHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />}
    </>
  );
}
