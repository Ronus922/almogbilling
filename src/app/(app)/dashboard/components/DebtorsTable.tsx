'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  ArrowUp, ArrowDown, Archive, ArchiveRestore, MessageSquare, MessageCircle,
  ChevronRight, ChevronLeft, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Debtor, SortKey, TabKey } from '@/lib/db/debtors';
import { formatPhoneDisplay, getPrimaryPhone } from '@/lib/phone';
import { TenantDetailPanel } from '@/components/tenant-detail-panel/TenantDetailPanel';
import { WhatsAppSendPanel, type WhatsAppRecipient } from '@/components/whatsapp/WhatsAppSendPanel';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { QuickDocPopover } from './QuickDocPopover';

const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const ils = (v: number) => `₪ ${numFmt.format(v)}`;

type SortField = 'apt' | 'owner' | 'total_debt' | 'management_fees' | 'hot_water_debt' | 'legal_status';

function parseSortKey(k: SortKey): { field: SortField; dir: 'asc' | 'desc' } {
  if (k.endsWith('_asc')) return { field: k.slice(0, -4) as SortField, dir: 'asc' };
  return { field: k.slice(0, -5) as SortField, dir: 'desc' };
}

interface MarkDoneTarget {
  debtorId: string;
  apartment: string;
  description: string | null;
  due_date: string | null;
}

interface ArchiveTarget {
  debtorId: string;
  apartment: string;
  owner: string | null;
}

export function DebtorsTable({
  rows,
  page,
  totalPages,
  currentSort,
  currentTab,
  isAdmin,
  canArchive,
  canSendWhatsapp,
}: {
  rows: Debtor[];
  page: number;
  totalPages: number;
  currentSort: SortKey;
  currentTab: TabKey;
  isAdmin: boolean;
  canArchive: boolean;
  canSendWhatsapp: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [markDone, setMarkDone] = useState<MarkDoneTarget | null>(null);
  const [marking, setMarking] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [unarchiveTarget, setUnarchiveTarget] = useState<ArchiveTarget | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);
  const [whatsappTarget, setWhatsappTarget] = useState<WhatsAppRecipient | null>(null);
  const [whatsappOpen, setWhatsappOpen] = useState(false);

  useEscapeKey(markDone !== null && !marking, () => setMarkDone(null));
  useEscapeKey(archiveTarget !== null && !archiving, () => setArchiveTarget(null));
  useEscapeKey(unarchiveTarget !== null && !unarchiving, () => setUnarchiveTarget(null));

  // Deep-link support: ?apt=X&open=details opens the panel for that debtor
  // (used from /statuses → "linked debtors" navigation). Strips the params
  // afterwards so the URL doesn't keep filtering the table to one row.
  useEffect(() => {
    if (searchParams.get('open') !== 'details') return;
    const apt = searchParams.get('apt');
    if (!apt) return;
    const row = rows.find((d) => d.apartment_number === apt);
    if (!row) return;
    setSelectedId(row.id);
    setPanelOpen(true);
    const next = new URLSearchParams(searchParams.toString());
    next.delete('apt');
    next.delete('open');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // run-once on mount/initial rows; subsequent searchParams changes are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isActionsTab = currentTab === 'actions';
  const isArchivedTab = currentTab === 'archived';

  async function confirmArchive() {
    if (!archiveTarget || archiving) return;
    setArchiving(true);
    try {
      const res = await fetch(`/api/debtors/${archiveTarget.debtorId}/archive`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('הדייר הועבר לארכיון');
      setArchiveTarget(null);
      router.refresh();
    } catch (err) {
      toast.error(`כישלון: ${(err as Error).message}`);
    } finally {
      setArchiving(false);
    }
  }

  async function confirmUnarchive() {
    if (!unarchiveTarget || unarchiving) return;
    setUnarchiving(true);
    try {
      const res = await fetch(`/api/debtors/${unarchiveTarget.debtorId}/archive`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('הדייר הוחזר מהארכיון');
      setUnarchiveTarget(null);
      router.refresh();
    } catch (err) {
      toast.error(`כישלון: ${(err as Error).message}`);
    } finally {
      setUnarchiving(false);
    }
  }

  async function confirmMarkDone() {
    if (!markDone || marking) return;
    setMarking(true);
    try {
      const res = await fetch(`/api/debtors/${markDone.debtorId}/complete-action`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('המשימה סומנה כבוצעה');
      setMarkDone(null);
      router.refresh();
    } catch (err) {
      toast.error(`כישלון: ${(err as Error).message}`);
    } finally {
      setMarking(false);
    }
  }

  function openPanel(id: string) {
    setSelectedId(id);
    setPanelOpen(true);
  }

  function openWhatsapp(d: Debtor) {
    setWhatsappTarget({
      id: d.id,
      apartment_number: d.apartment_number,
      owner_name: d.owner_name,
      tenant_name: d.tenant_name,
      phone_owner: d.phone_owner,
      phone_tenant: d.phone_tenant,
      total_debt: d.total_debt,
      address: d.address,
    });
    setWhatsappOpen(true);
  }

  function setSort(next: SortKey) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', next);
    params.delete('page');
    router.push(`${pathname}?${params.toString()}`);
  }

  function handleSortClick(field: SortField) {
    const { field: curField, dir } = parseSortKey(currentSort);
    const nextDir = curField === field ? (dir === 'asc' ? 'desc' : 'asc') : 'desc';
    setSort(`${field}_${nextDir}` as SortKey);
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין נתונים להצגה. ייבוא ראשון יבצע אכלוס של הטבלה.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <SortHead field="apt" label="מס׳ דירה" align="right" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="owner" label="שם בעל הדירה" align="right" currentSort={currentSort} onSort={handleSortClick} />
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">טלפון</TableHead>
              <SortHead field="total_debt" label="סה״כ חוב" align="center" toneColor="text-orange-500" toneHover="hover:text-orange-600" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="management_fees" label="דמי ניהול" align="center" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="hot_water_debt" label="מים חמים" align="center" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="legal_status" label="מצב משפטי" align="center" currentSort={currentSort} onSort={handleSortClick} />
              {isActionsTab && (
                <>
                  <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">פעולה לביצוע</TableHead>
                  <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">תאריך יעד</TableHead>
                </>
              )}
              {isArchivedTab && (
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">הועבר לארכיון</TableHead>
              )}
              <TableHead className="h-11 px-4 text-left text-sm font-semibold text-slate-500">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => {
              const phone = formatPhoneDisplay(getPrimaryPhone(d));
              return (
                <TableRow
                  key={d.id}
                  onClick={() => openPanel(d.id)}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-12"
                >
                  <TableCell className="px-4 py-3 text-right text-sm font-bold text-slate-900 tabular-nums">
                    {d.apartment_number}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right text-sm font-medium text-slate-800">
                    <span className="inline-flex items-center gap-1.5">
                      <span>{d.owner_name ?? '—'}</span>
                      <DocIndicator count={d.doc_count} lastAt={d.last_doc_at} />
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm text-slate-500 tabular-nums" dir="ltr">
                    {phone ?? '—'}
                  </TableCell>
                  <TableCell dir="ltr" className="px-4 py-3 text-center text-sm font-bold text-red-600 tabular-nums">
                    {ils(d.total_debt)}
                  </TableCell>
                  <TableCell dir="ltr" className="px-4 py-3 text-center text-sm font-bold text-blue-700 tabular-nums">
                    {ils(d.management_fees)}
                  </TableCell>
                  <TableCell dir="ltr" className="px-4 py-3 text-center text-sm font-bold text-purple-600 tabular-nums">
                    {ils(d.hot_water_debt)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center">
                    <LegalStatusPill
                      name={d.legal_status_name}
                      color={d.legal_status_color}
                      isDefault={d.legal_status_is_default}
                    />
                  </TableCell>
                  {isActionsTab && (
                    <>
                      <TableCell className="px-4 py-3 text-right text-sm text-slate-700">
                        {truncate(d.next_action_description, 30)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-center text-sm" dir="ltr">
                        <DueDateCell iso={d.next_action_date} />
                      </TableCell>
                    </>
                  )}
                  {isArchivedTab && (
                    <TableCell className="px-4 py-3 text-center text-sm text-slate-600 tabular-nums" dir="ltr">
                      {formatDueDate(d.archived_at)}
                    </TableCell>
                  )}
                  <TableCell className="px-4 py-3 text-left" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      debtorId={d.id}
                      apartment={d.apartment_number}
                      owner={d.owner_name}
                      canEdit={canArchive}
                      whatsappReason={!canSendWhatsapp ? 'אין הרשאה' : !phone ? 'אין מספר טלפון' : null}
                      onWhatsApp={() => openWhatsapp(d)}
                      showCheck={isActionsTab && isAdmin}
                      onCheck={() => setMarkDone({
                        debtorId: d.id,
                        apartment: d.apartment_number,
                        description: d.next_action_description,
                        due_date: d.next_action_date,
                      })}
                      onArchive={canArchive && !isArchivedTab ? () => setArchiveTarget({
                        debtorId: d.id,
                        apartment: d.apartment_number,
                        owner: d.owner_name,
                      }) : undefined}
                      onUnarchive={canArchive && isArchivedTab ? () => setUnarchiveTarget({
                        debtorId: d.id,
                        apartment: d.apartment_number,
                        owner: d.owner_name,
                      }) : undefined}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            עמוד {page} מתוך {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Link
              href={page > 1 ? `${pathname}?${withPage(searchParams, page - 1)}` : '#'}
              aria-disabled={page <= 1}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md border px-2', page <= 1 && 'pointer-events-none opacity-50')}
            >
              <ChevronRight className="h-4 w-4" />
              הקודם
            </Link>
            <Link
              href={page < totalPages ? `${pathname}?${withPage(searchParams, page + 1)}` : '#'}
              aria-disabled={page >= totalPages}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md border px-2', page >= totalPages && 'pointer-events-none opacity-50')}
            >
              הבא
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </div>
        </div>
      )}

      <TenantDetailPanel
        open={panelOpen}
        debtorId={selectedId}
        isAdmin={isAdmin}
        onOpenChange={(o) => {
          setPanelOpen(o);
          if (!o) setSelectedId(null);
        }}
      />

      <WhatsAppSendPanel
        open={whatsappOpen}
        recipient={whatsappTarget}
        onOpenChange={(o) => {
          setWhatsappOpen(o);
          if (!o) setWhatsappTarget(null);
        }}
        onSent={() => router.refresh()}
      />

      <AlertDialog
        open={markDone !== null}
        onOpenChange={(o) => { if (!o) setMarkDone(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>סמן את המשימה כבוצעה?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line text-right">
              {markDone && `פעולה: ${markDone.description ?? '(ללא תיאור)'}\nתאריך יעד: ${formatDueDate(markDone.due_date)}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={marking}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmMarkDone}
              disabled={marking}
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              {marking ? 'מסמן…' : 'סמן כבוצעה'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(o) => { if (!o) setArchiveTarget(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להעביר לארכיון?</AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              {archiveTarget && `דירה ${archiveTarget.apartment}${archiveTarget.owner ? ` · ${archiveTarget.owner}` : ''} תוסר מרשימת החייבים ותעבור לטאב הארכיון.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmArchive}
              disabled={archiving}
              className="gap-2 bg-orange-500 text-white hover:bg-orange-600"
            >
              <Archive className="h-4 w-4" />
              {archiving ? 'מעביר…' : 'העבר לארכיון'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={unarchiveTarget !== null}
        onOpenChange={(o) => { if (!o) setUnarchiveTarget(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להחזיר מהארכיון?</AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              {unarchiveTarget && `דירה ${unarchiveTarget.apartment}${unarchiveTarget.owner ? ` · ${unarchiveTarget.owner}` : ''} תוחזר לרשימת החייבים.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unarchiving}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmUnarchive}
              disabled={unarchiving}
              className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
            >
              <ArchiveRestore className="h-4 w-4" />
              {unarchiving ? 'מחזיר…' : 'החזר מהארכיון'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── helpers used inside the component file ───
function truncate(s: string | null, n: number): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// next_action_date may arrive as a string (API JSON path) or as a Date (RSC SSR
// path — pg returns Date objects which React 19 preserves through to the client).
// Coerce both into a valid Date or null.
function toDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDueDate(input: unknown): string {
  const d = toDate(input);
  return d ? format(d, 'dd/MM/yyyy') : '—';
}

function compareToToday(input: unknown): 'past' | 'today' | 'future' | null {
  const d = toDate(input);
  if (!d) return null;
  const dayOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = dayOnly.getTime() - today.getTime();
  if (diff === 0) return 'today';
  return diff < 0 ? 'past' : 'future';
}

function DueDateCell({ iso }: { iso: unknown }) {
  const d = toDate(iso);
  if (!d) return <span className="text-slate-400">—</span>;
  const cmp = compareToToday(iso);
  const label = formatDueDate(iso);
  if (cmp === 'past') {
    return (
      <span className="inline-flex items-center gap-1 text-red-600 font-semibold tabular-nums">
        <AlertTriangle className="h-3 w-3" />
        {label}
      </span>
    );
  }
  if (cmp === 'today') {
    return <span className="text-orange-600 font-bold tabular-nums">{label}</span>;
  }
  return <span className="text-slate-700 tabular-nums">{label}</span>;
}

function withPage(sp: URLSearchParams, p: number) {
  const params = new URLSearchParams(sp.toString());
  if (p === 1) params.delete('page'); else params.set('page', String(p));
  return params.toString();
}

function SortHead({
  field, label, align, toneColor, toneHover, currentSort, onSort,
}: {
  field: SortField;
  label: string;
  align: 'right' | 'center' | 'left';
  toneColor?: string;
  toneHover?: string;
  currentSort: SortKey;
  onSort: (field: SortField) => void;
}) {
  const { field: curField, dir } = parseSortKey(currentSort);
  const isActive = curField === field;
  const ArrowIcon = isActive && dir === 'asc' ? ArrowUp : ArrowDown;

  const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const base = toneColor ?? 'text-slate-500';
  const hover = toneHover ?? 'hover:text-slate-700';
  const activeClr = toneColor ? '' : 'text-slate-700';

  return (
    <TableHead className={cn('h-11 px-4', textAlign)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'group inline-flex items-center gap-1 text-sm font-semibold transition-colors',
          base, hover,
          isActive && activeClr,
        )}
      >
        {label}
        <ArrowIcon
          className={cn(
            'h-3.5 w-3.5 transition-opacity',
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
          )}
        />
      </button>
    </TableHead>
  );
}

// Small documentation badge next to the owner name: count of comments + events,
// shown only when > 0, with the last-documented date in the tooltip.
function DocIndicator({ count, lastAt }: { count: number; lastAt: unknown }) {
  if (!count || count <= 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 tabular-nums">
          <MessageSquare className="h-3 w-3" />
          {count}
        </span>
      </TooltipTrigger>
      <TooltipContent>תיעוד אחרון: {formatDueDate(lastAt)}</TooltipContent>
    </Tooltip>
  );
}

function LegalStatusPill({
  name, color, isDefault,
}: { name: string | null; color: string | null; isDefault: boolean | null }) {
  if (!name || isDefault) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-0.5 text-xs font-semibold text-slate-500">
        —
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold text-slate-900"
      style={{ backgroundColor: color ?? '#e5e7eb' }}
    >
      {name}
    </span>
  );
}

function RowActions({
  debtorId,
  apartment,
  owner,
  canEdit,
  whatsappReason,
  onWhatsApp,
  showCheck,
  onCheck,
  onArchive,
  onUnarchive,
}: {
  debtorId: string;
  apartment: string;
  owner: string | null;
  canEdit: boolean;
  /** null = enabled; a string = disabled reason shown in the tooltip. */
  whatsappReason: string | null;
  onWhatsApp: () => void;
  showCheck?: boolean;
  onCheck?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  return (
    <div dir="ltr" className="flex items-center justify-start gap-3">
      {showCheck && onCheck && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <button
              type="button"
              onClick={onCheck}
              aria-label="סמן כבוצעה"
              className="inline-flex items-center justify-center text-emerald-600 hover:text-emerald-700 transition-colors"
            >
              <CheckCircle2 className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>סמן כבוצעה</TooltipContent>
        </Tooltip>
      )}
      {onArchive && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <button
              type="button"
              onClick={onArchive}
              aria-label="העבר לארכיון"
              className="inline-flex items-center justify-center text-orange-500 hover:text-orange-600 transition-colors"
            >
              <Archive className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>העבר לארכיון</TooltipContent>
        </Tooltip>
      )}
      {onUnarchive && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <button
              type="button"
              onClick={onUnarchive}
              aria-label="החזר מהארכיון"
              className="inline-flex items-center justify-center text-blue-600 hover:text-blue-700 transition-colors"
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>החזר מהארכיון</TooltipContent>
        </Tooltip>
      )}
      <QuickDocPopover debtorId={debtorId} apartment={apartment} owner={owner} canEdit={canEdit} />
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <button
            type="button"
            onClick={whatsappReason ? undefined : onWhatsApp}
            disabled={whatsappReason !== null}
            aria-label="שליחת WhatsApp"
            className="inline-flex items-center justify-center text-green-500 transition-colors hover:text-green-600 disabled:cursor-default disabled:text-slate-300"
          >
            <MessageCircle className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{whatsappReason ?? 'שליחת WhatsApp'}</TooltipContent>
      </Tooltip>
    </div>
  );
}
