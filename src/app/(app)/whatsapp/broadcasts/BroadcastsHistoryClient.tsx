'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Megaphone, Plus, Search, Eye, OctagonX, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CampaignListItem, CampaignListPage, CampaignStatus } from '@/lib/wa-queue/types';
import { CampaignStatusBadge } from './_components/StatusBadge';
import { StopBroadcastDialog } from './_components/StopBroadcastDialog';
import { useStopBroadcast } from './_lib/useStopBroadcast';
import { usePoll } from './_lib/usePoll';
import {
  STATUS_META, isCancellable, isTerminal, progressPct, processed, audienceLabel,
} from './_lib/status';

const PAGE_SIZE = 20;
const ALL = '__all__';
const STATUS_OPTIONS: CampaignStatus[] = [
  'queued', 'running', 'paused', 'completed', 'completed_with_errors', 'cancelled', 'failed',
];

// Rendered both as the /whatsapp/broadcasts route AND embedded inside the
// broadcast window's "היסטוריית תפוצות" tab. `embedded` drops the page header;
// `onOpenDetail`/`onCreate` keep navigation inside the window instead of routing.
export function BroadcastsHistoryClient({
  canEdit,
  embedded = false,
  onOpenDetail,
  onCreate,
}: {
  canEdit: boolean;
  embedded?: boolean;
  onOpenDetail?: (id: string) => void;
  onCreate?: () => void;
}) {
  const router = useRouter();
  const openCreate = onCreate ?? (() => router.push('/whatsapp/broadcasts/new'));
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  // Debounce the free-text search.
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const fetcher = useCallback(async (): Promise<CampaignListPage> => {
    const sp = new URLSearchParams();
    if (status !== ALL) sp.set('status', status);
    if (q) sp.set('q', q);
    if (from) sp.set('from', new Date(from).toISOString());
    if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); sp.set('to', d.toISOString()); }
    sp.set('limit', String(PAGE_SIZE));
    sp.set('offset', String(page * PAGE_SIZE));
    const r = await fetch(`/api/whatsapp/campaigns?${sp.toString()}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`טעינת ההיסטוריה נכשלה (HTTP ${r.status})`);
    return (await r.json()) as CampaignListPage;
  }, [status, q, from, to, page]);

  // Poll only while a listed broadcast is still active.
  const { data, loading, error, refetch } = usePoll<CampaignListPage>(fetcher, {
    intervalMs: 5000,
    shouldContinue: (d) => d.rows.some((c) => !isTerminal(c.status)),
    deps: [status, q, from, to, page],
  });

  const stop = useStopBroadcast(() => void refetch());

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = status !== ALL || q !== '' || from !== '' || to !== '';

  return (
    <div className="space-y-6">
      {/* Header — hidden when embedded; the window provides header + tabs. */}
      {!embedded && (
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
              <Megaphone className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-2xl font-extrabold text-slate-900">היסטוריית תפוצות</h1>
              <p className="mt-1 text-sm text-muted-foreground">כל תפוצות ה-WhatsApp — סטטוס, התקדמות ופרטי מסירה.</p>
            </div>
          </div>
          {canEdit && (
            <Button type="button" variant="approve" onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> תפוצה חדשה
            </Button>
          )}
        </div>
      )}

      {/* Toolbar: search + status + date range */}
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="חיפוש לפי שם תפוצה…" className="h-10 pe-9" />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v ?? ALL); setPage(0); }}>
          <SelectTrigger className="h-10 w-full lg:w-52 data-[size=default]:h-10">
            <SelectValue>
              {(v: string | null) => (!v || v === ALL ? 'כל הסטטוסים' : STATUS_META[v as CampaignStatus]?.label ?? v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>כל הסטטוסים</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className="h-10" aria-label="מתאריך" />
          <span className="text-sm text-slate-400">—</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className="h-10" aria-label="עד תאריך" />
        </div>
      </div>

      {/* Table / states */}
      {loading && !data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-lg bg-slate-100 animate-pulse" />)}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">
          {error} <button onClick={() => void refetch()} className="mx-1 font-semibold underline">נסה שוב</button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState hasFilters={hasFilters} canEdit={canEdit} onCreate={openCreate} />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          {/* מובייל (<md) — כרטיס לכל תפוצה. הטבלה היא 12 עמודות, הרחבה
              במערכת. הכרטיס נשען על אותם props/handlers כמו <Row>
              (onOpen / onStop / canEdit) — אין state או לוגיקה נפרדת. */}
          <ul className="space-y-2 p-3 roomy:hidden">
            {rows.map((c) => (
              <MobileCard
                key={c.id}
                c={c}
                canEdit={canEdit}
                onStop={() => stop.request(c)}
                onOpen={onOpenDetail ? () => onOpenDetail(c.id) : undefined}
              />
            ))}
          </ul>

          <Table className="hidden roomy:table">
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                {['שם התפוצה', 'תאריך יצירה', 'נוצר על ידי', 'קהל יעד', 'תבנית', 'סטטוס', 'התקדמות', 'נשלחו', 'נכשלו', 'בוטלו', 'סך הכול', 'פעולות'].map((h, i) => (
                  <TableHead key={h} className={cn('h-11 px-3 text-sm font-semibold text-slate-500', i >= 7 && i <= 10 ? 'text-center' : 'text-start', i === 11 && 'text-end')}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <Row
                  key={c.id}
                  c={c}
                  canEdit={canEdit}
                  onStop={() => stop.request(c)}
                  onOpen={onOpenDetail ? () => onOpenDetail(c.id) : undefined}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span className="tabular-nums">עמוד {page + 1} מתוך {totalPages} · {total} תפוצות</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="gap-1">
              <ChevronRight className="h-4 w-4" /> הקודם
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="gap-1">
              הבא <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

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

/** Mobile counterpart of <Row> — identical data and identical actions, arranged
 *  as a card. Same prop shape on purpose, so the two variants cannot drift. */
function MobileCard({ c, canEdit, onStop, onOpen }: { c: CampaignListItem; canEdit: boolean; onStop: () => void; onOpen?: () => void }) {
  const active = !isTerminal(c.status);
  const pct = progressPct(c);
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-slate-900">{c.name}</span>
        <CampaignStatusBadge status={c.status} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-slate-500">
        <span className="tabular-nums">{formatDate(c.created_at)}</span>
        <span>{c.created_by_name ?? '—'}</span>
        <span>{audienceLabel(c.audience)}</span>
        <span className="truncate">{c.template_name ?? 'כתיבה חופשית'}</span>
      </div>

      {active && (
        <div className="mt-2 space-y-1">
          <Progress value={pct} className="h-1.5" />
          <div className="flex items-center justify-between text-[12px] tabular-nums text-slate-500">
            <span>{processed(c)} מתוך {c.total_count}</span>
            <span>{pct}%</span>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
        <div className="flex flex-wrap items-center gap-x-3 text-[12.5px] tabular-nums">
          <span className="font-semibold text-emerald-700">נשלחו {c.sent_count}</span>
          <span className="font-semibold text-red-600">נכשלו {c.failed_count}</span>
          <span className="text-slate-600">בוטלו {c.cancelled_count + c.skipped_count}</span>
          <span className="font-semibold text-slate-700">סה״כ {c.total_count}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpen ? (
            <Button type="button" variant="ghost" size="icon" onClick={onOpen} aria-label="צפייה בפרטים">
              <Eye className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon" render={<Link href={`/whatsapp/broadcasts/${c.id}`} />} aria-label="צפייה בפרטים">
              <Eye className="h-4 w-4" />
            </Button>
          )}
          {canEdit && isCancellable(c.status) && (
            <Button type="button" variant="ghost" size="icon" onClick={onStop} aria-label="עצירת התפוצה" className="text-red-500 hover:bg-red-50 hover:text-red-600">
              <OctagonX className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function Row({ c, canEdit, onStop, onOpen }: { c: CampaignListItem; canEdit: boolean; onStop: () => void; onOpen?: () => void }) {
  const active = !isTerminal(c.status);
  const pct = progressPct(c);
  return (
    <TableRow className="border-b border-slate-100 hover:bg-slate-50">
      <TableCell className="px-3 py-3 text-start text-sm font-bold text-slate-900 max-w-[220px] truncate">{c.name}</TableCell>
      <TableCell className="px-3 py-3 text-start text-sm text-slate-600 whitespace-nowrap tabular-nums">{formatDate(c.created_at)}</TableCell>
      <TableCell className="px-3 py-3 text-start text-sm text-slate-600">{c.created_by_name ?? '—'}</TableCell>
      <TableCell className="px-3 py-3 text-start text-sm text-slate-600">{audienceLabel(c.audience)}</TableCell>
      <TableCell className="px-3 py-3 text-start text-sm text-slate-600 max-w-[140px] truncate">{c.template_name ?? 'כתיבה חופשית'}</TableCell>
      <TableCell className="px-3 py-3 text-start"><CampaignStatusBadge status={c.status} /></TableCell>
      <TableCell className="px-3 py-3 min-w-[150px]">
        {active ? (
          <div className="space-y-1">
            <Progress value={pct} className="h-1.5" />
            <div className="flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
              <span>{processed(c)} מתוך {c.total_count}</span>
              <span>{pct}%</span>
            </div>
          </div>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </TableCell>
      <TableCell className="px-3 py-3 text-center text-sm font-semibold text-emerald-700 tabular-nums">{c.sent_count}</TableCell>
      <TableCell className="px-3 py-3 text-center text-sm font-semibold text-red-600 tabular-nums">{c.failed_count}</TableCell>
      <TableCell className="px-3 py-3 text-center text-sm text-slate-600 tabular-nums">{c.cancelled_count + c.skipped_count}</TableCell>
      <TableCell className="px-3 py-3 text-center text-sm font-semibold text-slate-700 tabular-nums">{c.total_count}</TableCell>
      <TableCell className="px-3 py-3 text-end">
        <div dir="ltr" className="flex items-center justify-start gap-1">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {onOpen ? (
                <Button type="button" variant="ghost" size="icon" onClick={onOpen} aria-label="צפייה בפרטים">
                  <Eye className="h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="icon" render={<Link href={`/whatsapp/broadcasts/${c.id}`} />} aria-label="צפייה בפרטים">
                  <Eye className="h-4 w-4" />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent>צפייה בפרטים</TooltipContent>
          </Tooltip>
          {canEdit && isCancellable(c.status) && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button type="button" variant="ghost" size="icon" onClick={onStop} aria-label="עצירת התפוצה" className="text-red-500 hover:bg-red-50 hover:text-red-600">
                  <OctagonX className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>עצירת התפוצה</TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ hasFilters, canEdit, onCreate }: { hasFilters: boolean; canEdit: boolean; onCreate: () => void }) {
  if (hasFilters) {
    return <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">לא נמצאו תפוצות התואמות לסינון.</div>;
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-50 text-emerald-600"><Megaphone className="h-6 w-6" /></span>
      <h3 className="text-base font-semibold text-slate-900">טרם נשלחו תפוצות</h3>
      <p className="text-sm text-muted-foreground">צור תפוצה ראשונה כדי לשלוח הודעה לקבוצת נמענים.</p>
      {canEdit && <Button type="button" variant="approve" onClick={onCreate} className="mt-2 gap-2"><Plus className="h-4 w-4" /> תפוצה חדשה</Button>}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
