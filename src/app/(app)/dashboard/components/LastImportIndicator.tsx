'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarSync, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { computeSeverity, type Severity } from '@/lib/dashboard/syncStatus';
import { useHasMounted } from '@/lib/hooks/useHasMounted';

const sevStyles: Record<Severity, { wrap: string; iconBg: string; iconFg: string }> = {
  ok:     { wrap: 'bg-white border-line text-ink',                       iconBg: 'bg-brand-soft', iconFg: 'text-brand' },
  yellow: { wrap: 'bg-[#fff6e6] border-[#e08700]/30 text-[#945700]',     iconBg: 'bg-white/70',   iconFg: 'text-[#e08700]' },
  red:    { wrap: 'bg-[#feefef] border-[#e5484d]/30 text-[#b01b20]',     iconBg: 'bg-white/70',   iconFg: 'text-[#e5484d]' },
};

const formatter = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', // server runs UTC; anchor display to the business tz
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatStamp(d: Date) {
  // Force DD.MM.YYYY HH:mm regardless of locale's separator quirks.
  const parts = formatter.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

export function LastImportIndicator({
  lastImportAt,
  lastSyncAt,
  canSync,
}: {
  lastImportAt: Date | null;
  lastSyncAt: Date | null;
  canSync: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);

  // Both timestamps are held in state so a successful sync can update them
  // immediately, before the background router.refresh() lands.
  const [importAt, setImportAt] = useState<Date | null>(lastImportAt);
  const [syncAt, setSyncAt] = useState<Date | null>(lastSyncAt);

  useEffect(() => { setImportAt(lastImportAt); }, [lastImportAt]);
  useEffect(() => { setSyncAt(lastSyncAt); }, [lastSyncAt]);

  // computeSeverity reads Date.now(), which differs between SSR and hydration —
  // compute it only after mount and render the calm 'ok' state until then, so the
  // first client paint matches the server markup (avoids React #418).
  const mounted = useHasMounted();
  const severity: Severity = mounted ? computeSeverity(importAt, Date.now()) : 'ok';
  const styles = sevStyles[severity];

  const importStr = importAt ? formatStamp(importAt) : null;
  const syncStr = syncAt ? formatStamp(syncAt) : null;

  const subline =
    severity === 'red'
      ? importAt
        ? 'הנתונים לא עודכנו ב-48 השעות האחרונות — מומלץ לבצע ייבוא'
        : 'לא בוצע ייבוא מעולם'
      : severity === 'yellow'
      ? 'הנתונים לא עודכנו מעל 24 שעות'
      : null;

  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/bllink', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; syncedAt?: string }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success('הסנכרון הופעל בהצלחה');

      // Refresh both timestamps from the combined endpoint (sync updates
      // immediately); fall back to the POST's syncedAt if the read fails.
      try {
        const s = await fetch('/api/sync/status', { credentials: 'include' });
        if (s.ok) {
          const j = (await s.json()) as { lastImportAt: string | null; lastSyncAt: string | null };
          setImportAt(j.lastImportAt ? new Date(j.lastImportAt) : null);
          setSyncAt(j.lastSyncAt ? new Date(j.lastSyncAt) : null);
        } else if (body?.syncedAt) {
          setSyncAt(new Date(body.syncedAt));
        }
      } catch {
        if (body?.syncedAt) setSyncAt(new Date(body.syncedAt));
      }

      startTransition(() => router.refresh());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`סנכרון נכשל: ${msg}`);
    } finally {
      setSyncing(false);
    }
  }

  const showWarning = severity !== 'ok';

  return (
    <div className={cn('flex flex-col gap-3 rounded-2xl border px-5 py-3.5 shadow-soft-xs md:flex-row md:items-center md:justify-between', styles.wrap)}>
      <div className="flex items-center gap-3">
        <div className={cn('grid h-10 w-10 place-items-center rounded-xl', styles.iconBg, styles.iconFg)}>
          <CalendarSync className="h-5 w-5" aria-hidden />
        </div>
        <div className="leading-tight">
          {/* Primary — last import (drives the freshness severity) */}
          <div className="font-semibold">
            ייבוא אחרון:{' '}
            {importStr
              ? <span className="font-num font-medium tabular-nums">{importStr}</span>
              : <span className="opacity-80">טרם בוצע ייבוא</span>}
          </div>
          {/* Secondary — last successful sync (informational only) */}
          <div className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-2">
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
            <span>
              סנכרון אחרון:{' '}
              {syncStr
                ? <span className="font-num tabular-nums">{syncStr}</span>
                : <span className="text-ink-3">טרם בוצע סנכרון</span>}
            </span>
          </div>
          {subline && <div className="mt-0.5 text-xs opacity-80">{subline}</div>}
        </div>
      </div>
      <div className="flex items-center gap-2">
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
  );
}
