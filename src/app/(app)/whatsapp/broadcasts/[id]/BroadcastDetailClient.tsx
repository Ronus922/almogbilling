'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Megaphone, OctagonX, ChevronLeft, ChevronRight, AlertTriangle,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type {
  CampaignDetail, RecipientLogPage, RecipientStatus,
} from '@/lib/wa-queue/types';
import { CampaignStatusBadge, RecipientStatusBadge } from '../_components/StatusBadge';
import { StopBroadcastDialog } from '../_components/StopBroadcastDialog';
import { useStopBroadcast } from '../_lib/useStopBroadcast';
import { usePoll } from '../_lib/usePoll';
import { isCancellable, isTerminal, progressPct, processed, audienceLabel } from '../_lib/status';

const LOG_PAGE = 50;
type LogFilter = 'all' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled';
const LOG_TABS: { value: LogFilter; label: string }[] = [
  { value: 'all', label: 'הכול' },
  { value: 'pending', label: 'ממתינים' },
  { value: 'sent', label: 'נשלחו' },
  { value: 'delivered', label: 'נמסרו' },
  { value: 'read', label: 'נקראו' },
  { value: 'failed', label: 'נכשלו' },
  { value: 'cancelled', label: 'בוטלו' },
];

// Rendered both as the /whatsapp/broadcasts/[id] route AND embedded inside the
// broadcast window (delivery-log view). `onBack`, when provided, returns to the
// window's history tab / active card instead of routing to the history page.
export function BroadcastDetailClient({ id, canEdit, onBack }: { id: string; canEdit: boolean; onBack?: () => void }) {
  const fetcher = useCallback(async (): Promise<CampaignDetail> => {
    const r = await fetch(`/api/whatsapp/campaigns/${id}`, { credentials: 'include' });
    if (r.status === 404) throw new Error('התפוצה לא נמצאה');
    if (!r.ok) throw new Error(`טעינת התפוצה נכשלה (HTTP ${r.status})`);
    return (await r.json()) as CampaignDetail;
  }, [id]);

  const { data: c, loading, error, refetch } = usePoll<CampaignDetail>(fetcher, {
    intervalMs: 3000,
    shouldContinue: (d) => !isTerminal(d.status),
    deps: [id],
  });
  const stop = useStopBroadcast(() => void refetch());

  if (loading && !c) return <div className="space-y-3"><div className="h-24 rounded-xl bg-slate-100 animate-pulse" /><div className="h-64 rounded-xl bg-slate-100 animate-pulse" /></div>;
  if (error && !c) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">
        {error}
        <div className="mt-3">
          {onBack ? (
            <Button variant="outline" size="sm" onClick={onBack}>חזרה להיסטוריה</Button>
          ) : (
            <Button variant="outline" size="sm" render={<Link href="/whatsapp/broadcasts" />}>חזרה להיסטוריה</Button>
          )}
        </div>
      </div>
    );
  }
  if (!c) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex items-center gap-3">
          {onBack ? (
            <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="חזרה">
              <ArrowRight className="h-5 w-5" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon" render={<Link href="/whatsapp/broadcasts" />} aria-label="חזרה">
              <ArrowRight className="h-5 w-5" />
            </Button>
          )}
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Megaphone className="h-5 w-5" /></span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900">{c.name}</h1>
              <CampaignStatusBadge status={c.status} />
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              נוצר על ידי {c.created_by_name ?? '—'} · {audienceLabel(c.audience)} · {c.template_name ?? 'כתיבה חופשית'}
            </p>
          </div>
        </div>
        {canEdit && isCancellable(c.status) && (
          <Button type="button" onClick={() => stop.request(c)} className="gap-2 bg-destructive text-white hover:bg-destructive/90">
            <OctagonX className="h-4 w-4" /> עצירת התפוצה
          </Button>
        )}
      </div>

      {/* Summary counts + progress */}
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="סך נמענים" value={c.total_count} tone="text-slate-800" />
          <Metric label="נשלחו" value={c.sent_count} tone="text-emerald-700" />
          <Metric label="נמסרו" value={c.delivered_count} tone="text-emerald-600" />
          <Metric label="נקראו" value={c.read_count} tone="text-blue-600" />
          <Metric label="נכשלו" value={c.failed_count} tone="text-red-600" />
          <Metric label="בוטלו" value={c.cancelled_count + c.skipped_count} tone="text-slate-600" />
          <Metric label="נותרו" value={c.pending_count + c.processing_count} tone="text-amber-600" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-sm text-slate-500 tabular-nums">
            <span>התקדמות</span>
            <span>{processed(c)} מתוך {c.total_count} · {progressPct(c)}%</span>
          </div>
          <Progress value={progressPct(c)} />
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="נוצרה" value={formatDT(c.created_at)} />
          <Field label="החלה" value={formatDT(c.started_at)} />
          <Field label="הסתיימה" value={formatDT(c.completed_at)} />
          <Field label="נעצרה" value={formatDT(c.cancelled_at)} />
        </dl>
      </div>

      {/* Delivery log */}
      <RecipientLog campaignId={id} pollKey={c.updated_at} />

      <StopBroadcastDialog
        open={stop.target !== null}
        onOpenChange={(o) => { if (!o) stop.close(); }}
        counts={stop.counts}
        pending={stop.pending}
        onConfirm={() => void stop.confirm()}
      />
    </div>
  );
}

function RecipientLog({ campaignId, pollKey }: { campaignId: string; pollKey: string }) {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<RecipientLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (filter !== 'all') sp.set('status', filter);
      sp.set('limit', String(LOG_PAGE));
      sp.set('offset', String(page * LOG_PAGE));
      const r = await fetch(`/api/whatsapp/campaigns/${campaignId}/recipients?${sp.toString()}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`טעינת יומן המסירה נכשלה (HTTP ${r.status})`);
      setData((await r.json()) as RecipientLogPage);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'שגיאת רשת');
    } finally {
      setLoading(false);
    }
  }, [campaignId, filter, page]);

  // Refetch on filter/page change, and whenever the campaign advances (pollKey).
  useEffect(() => { void load(); }, [load, pollKey]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-slate-900">יומן מסירה</h2>
        <div className="inline-flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
          {LOG_TABS.map((t) => (
            <button key={t.value} type="button" onClick={() => { setFilter(t.value); setPage(0); }}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
                filter === t.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-lg bg-slate-100 animate-pulse" />)}</div>
      ) : err ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">{err}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">אין נמענים בקטגוריה זו.</div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          <Table>
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                {['נמען', 'טלפון', 'דירה', 'סטטוס', 'נשלח בשעה', 'ניסיונות', 'פרטים'].map((h, i) => (
                  <TableHead key={h} className={cn('h-11 px-3 text-sm font-semibold text-slate-500', i === 5 ? 'text-center' : 'text-right')}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <TableCell className="px-3 py-3 text-right text-sm font-semibold text-slate-800 max-w-[180px] truncate">{r.debtor_name ?? '—'}</TableCell>
                  <TableCell className="px-3 py-3 text-right text-sm text-slate-600 tabular-nums" dir="ltr">{r.phone_masked}</TableCell>
                  <TableCell className="px-3 py-3 text-right text-sm text-slate-600">{r.apartment_number ?? '—'}</TableCell>
                  <TableCell className="px-3 py-3 text-right"><DeliveryStatus status={r.status} deliveredAt={r.delivered_at} readAt={r.read_at} /></TableCell>
                  <TableCell className="px-3 py-3 text-right text-sm text-slate-600 whitespace-nowrap tabular-nums">{r.sent_at ? formatDT(r.sent_at) : '—'}</TableCell>
                  <TableCell className="px-3 py-3 text-center text-sm text-slate-600 tabular-nums">{r.attempt_count}</TableCell>
                  <TableCell className="px-3 py-3 text-right text-sm text-slate-500 max-w-[260px] truncate">{detailText(r.status, r.last_error)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > LOG_PAGE && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span className="tabular-nums">עמוד {page + 1} מתוך {totalPages} · {total} נמענים</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="gap-1"><ChevronRight className="h-4 w-4" /> הקודם</Button>
            <Button type="button" variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="gap-1">הבא <ChevronLeft className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

// A sent recipient can further be delivered/read — surface that lifecycle inline
// without inventing a separate recipient state.
function DeliveryStatus({ status, deliveredAt, readAt }: { status: RecipientStatus; deliveredAt: string | null; readAt: string | null }) {
  if (status === 'sent' && readAt) return <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" />נקרא</span>;
  if (status === 'sent' && deliveredAt) return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />נמסר</span>;
  return <RecipientStatusBadge status={status} />;
}

function detailText(status: RecipientStatus, lastError: string | null): string {
  if (lastError) return lastError;
  if (status === 'cancelled') return 'בוטל לפני שליחה';
  return '—';
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-100 bg-slate-50 p-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={cn('text-xl font-extrabold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:justify-start">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm font-medium text-slate-700 tabular-nums">{value}</dd>
    </div>
  );
}

function formatDT(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
