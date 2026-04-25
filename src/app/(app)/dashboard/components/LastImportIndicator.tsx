'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarSync, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type Severity = 'ok' | 'yellow' | 'red';

function computeSeverity(lastImportAt: Date | null): Severity {
  if (!lastImportAt) return 'red';
  const hours = (Date.now() - lastImportAt.getTime()) / 36e5;
  if (hours > 48) return 'red';
  if (hours > 24) return 'yellow';
  return 'ok';
}

const sevStyles: Record<Severity, { wrap: string; iconBg: string; iconFg: string }> = {
  ok:     { wrap: 'bg-white border-slate-200 text-slate-800',     iconBg: 'bg-slate-100', iconFg: 'text-slate-600' },
  yellow: { wrap: 'bg-[#fef9c3] border-yellow-300 text-yellow-900', iconBg: 'bg-yellow-100', iconFg: 'text-yellow-700' },
  red:    { wrap: 'bg-[#fee2e2] border-red-300 text-red-900',     iconBg: 'bg-red-100',   iconFg: 'text-red-600' },
};

const formatter = new Intl.DateTimeFormat('he-IL', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDate(d: Date) {
  // Force DD.MM.YYYY HH:mm regardless of locale's separator quirks.
  const parts = formatter.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

export function LastImportIndicator({
  lastImportAt,
  isAdmin,
}: {
  lastImportAt: Date | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const severity = computeSeverity(lastImportAt);
  const styles = sevStyles[severity];

  const headline =
    severity === 'ok' && lastImportAt
      ? `העדכון האחרון בוצע: ${formatDate(lastImportAt)}`
      : severity === 'yellow' && lastImportAt
      ? `העדכון האחרון: ${formatDate(lastImportAt)} (מעל 24 שעות)`
      : 'נדרש לייבא נתונים מעדכניים';

  const subline =
    severity === 'red'
      ? lastImportAt
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
        | { error?: string; status?: number }
        | null;
      if (!res.ok) {
        const detail = body?.error ?? `HTTP ${res.status}`;
        throw new Error(detail);
      }
      toast.success('הסנכרון הופעל בהצלחה');
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
    <div className={cn('flex flex-col gap-3 rounded-xl border px-5 py-3 md:flex-row md:items-center md:justify-between', styles.wrap)}>
      <div className="flex items-center gap-3">
        <div className={cn('grid h-10 w-10 place-items-center rounded-full', styles.iconBg, styles.iconFg)}>
          <CalendarSync className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <div className="font-semibold">{headline}</div>
          {subline && <div className="text-sm opacity-80">{subline}</div>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isAdmin && (
          <Button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold gap-2"
          >
            <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
            <span>{syncing ? 'מסנכרן…' : 'סנכרן עכשיו'}</span>
          </Button>
        )}
        {isAdmin && showWarning && (
          <Button
            type="button"
            onClick={() => router.push('/import')}
            className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold gap-2"
          >
            <Upload className="h-4 w-4" />
            <span>ייבוא נתונים</span>
          </Button>
        )}
      </div>
    </div>
  );
}
