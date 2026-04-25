'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUp, ArrowDown, Archive, MessageSquare, MessageCircle,
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

export function DebtorsTable({
  rows,
  page,
  totalPages,
  currentSort,
  currentTab,
  isAdmin,
}: {
  rows: Debtor[];
  page: number;
  totalPages: number;
  currentSort: SortKey;
  currentTab: TabKey;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [markDone, setMarkDone] = useState<MarkDoneTarget | null>(null);
  const [marking, setMarking] = useState(false);

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
                    {d.owner_name ?? '—'}
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
                  <TableCell className="px-4 py-3 text-left" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      showCheck={isActionsTab && isAdmin}
                      onCheck={() => setMarkDone({
                        debtorId: d.id,
                        apartment: d.apartment_number,
                        description: d.next_action_description,
                        due_date: d.next_action_date,
                      })}
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

interface ActionDef {
  icon: LucideIcon;
  label: string;
  className: string;
}

// Order per user's latest screenshot (LTR visual: Archive | Comment | WhatsApp).
// dir="ltr" on the wrapper preserves this physical order inside the RTL page.
const ACTIONS: ActionDef[] = [
  { icon: Archive,       label: 'ארכוב',    className: 'text-orange-500 hover:text-orange-600' },
  { icon: MessageSquare, label: 'הערה',     className: 'text-slate-400 hover:text-slate-500' },
  { icon: MessageCircle, label: 'WhatsApp', className: 'text-green-500 hover:text-green-600' },
];

function RowActions({
  showCheck,
  onCheck,
}: {
  showCheck?: boolean;
  onCheck?: () => void;
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
      {ACTIONS.map((it) => (
        <Tooltip key={it.label}>
          <TooltipTrigger render={<span />}>
            <button
              type="button"
              disabled
              aria-label={it.label}
              className={cn(
                'inline-flex items-center justify-center transition-colors disabled:cursor-default',
                it.className,
              )}
            >
              <it.icon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
