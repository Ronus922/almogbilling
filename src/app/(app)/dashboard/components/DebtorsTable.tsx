'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { todayInJerusalem } from '@/lib/dates';
import { toast } from 'sonner';
import {
  ArrowUp, ArrowDown, Archive, ArchiveRestore, MessageSquare, MessageCircle,
  ChevronRight, ChevronLeft, AlertTriangle, CheckCircle2, Send, X,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Debtor, SortKey, TabKey } from '@/lib/db/debtors';
import { formatPhoneDisplay, getPrimaryPhone } from '@/lib/phone';
import { cleanPhoneField } from '@/lib/whatsapp';
import { TenantDetailPanel } from '@/components/tenant-detail-panel/TenantDetailPanel';
import { WhatsAppSendPanel, type WhatsAppRecipient } from '@/components/whatsapp/WhatsAppSendPanel';
import { WhatsAppBulkSendPanel } from '@/components/whatsapp/WhatsAppBulkSendPanel';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { QuickDocPopover } from './QuickDocPopover';

const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

/** Amount cell — Inter tabular number with a small ₪ on its right (RTL order:
 *  ₪ is the first child so it sits on the right; the digits stay LTR). */
function Amount({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-baseline justify-center gap-1 font-num font-bold tabular-nums', className)}>
      {/* Floor the sigil at 10px: at the desktop 14px cell 0.72em is already
          10.08px so nothing changes there, but the mobile card renders Amount
          at 12.5px, where a bare 0.72em would shrink ₪ to an illegible 9px. */}
      <span className="text-[12px] font-semibold opacity-70 roomy:text-[max(10px,0.72em)]">₪</span>
      <span dir="ltr">{numFmt.format(value)}</span>
    </span>
  );
}

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
  canChangeStatus,
  canArchive,
  canSendWhatsapp,
  canViewChips,
  canEditChips,
}: {
  rows: Debtor[];
  page: number;
  totalPages: number;
  currentSort: SortKey;
  currentTab: TabKey;
  canChangeStatus: boolean;
  canArchive: boolean;
  canSendWhatsapp: boolean;
  canViewChips: boolean;
  canEditChips: boolean;
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  // Selection is per-page: navigating / re-sorting / changing tab clears it so we
  // never bulk-send to rows that scrolled out of view.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, currentSort, currentTab]);

  const pageIds = rows.map((d) => d.id);
  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id));
  const allSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(() => (checked ? new Set(pageIds) : new Set()));
  }

  const bulkRecipients: WhatsAppRecipient[] = rows
    .filter((d) => selectedIds.has(d.id))
    .map(toRecipient);

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
    setWhatsappTarget(toRecipient(d));
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
      <div className="rounded-xl border border-line bg-surface-2 p-12 text-center text-sm text-ink-2">
        אין נתונים להצגה. ייבוא ראשון יבצע אכלוס של הטבלה.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canSendWhatsapp && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-2.5">
          <span className="text-sm font-semibold text-emerald-900">
            {selectedIds.size} נבחרו
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="approve"
              onClick={() => setBulkOpen(true)}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              שליחת WhatsApp
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              className="gap-1.5 text-slate-600 hover:text-slate-800"
            >
              <X className="h-4 w-4" />
              נקה בחירה
            </Button>
          </div>
        </div>
      )}
      {/* Mobile (<md) — one card per debtor. The desktop table is ten columns
          and ~1300px wide; inside a 320px phone that was a 5× horizontal
          scrub where nothing but the apartment number was ever on screen.
          Same data, same actions, same click target (opens the tenant panel);
          only the arrangement changes. Desktop is untouched. */}
      <ul className="space-y-2 roomy:hidden">
        {rows.map((d) => {
          const phone = formatPhoneDisplay(getPrimaryPhone(d));
          const waHasValidPhone = Boolean(
            cleanPhoneField(d.phone_owner) || cleanPhoneField(d.phone_tenant),
          );
          return (
            <li
              key={d.id}
              className={cn(
                'relative rounded-xl border border-line bg-white p-3 shadow-soft-xs',
                selectedIds.has(d.id) && 'border-emerald-300 bg-emerald-50/40',
              )}
            >
              {/* Stretched trigger: a real <button> covering the card, so the
                  whole card is tappable without nesting it inside another
                  button (invalid HTML — the card also holds a checkbox and a
                  RowActions menu, which sit above it on the z-axis). */}
              <button
                type="button"
                onClick={() => openPanel(d.id)}
                aria-label={`פתיחת דירה ${d.apartment_number}${d.owner_name ? ` — ${d.owner_name}` : ''}`}
                className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              />

              {/* The wrapper is transparent to pointer events so a tap anywhere
                  on the card falls through to the stretched button beneath it;
                  the interactive islands opt back in with `pointer-events-auto`.
                  Marking only the inner text block would NOT work — a tap on a
                  `pointer-events: none` child re-targets its nearest painted
                  ancestor, which is this wrapper (z-10), not the button (z-0). */}
              <div className="pointer-events-none relative z-10 flex items-start gap-3">
                {canSendWhatsapp && (
                  /* No `hit-44` here: the Checkbox primitive already grows its
                     own 44px hit box (`after:-inset-3.5`) targeting itself. A
                     wrapper-level ::after would paint above it and swallow the
                     tap — the span would become the click target, not the box. */
                  <span className="pointer-events-auto mt-0.5 shrink-0">
                    <Checkbox
                      checked={selectedIds.has(d.id)}
                      onCheckedChange={(v) => toggleOne(d.id, v === true)}
                      aria-label={`בחר דירה ${d.apartment_number}`}
                    />
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  {/* Identity: apartment + owner */}
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="font-num shrink-0 text-[15px] font-bold tabular-nums text-ink">
                      דירה {d.apartment_number}
                    </span>
                    <span className="truncate text-[14px] font-medium text-ink-2">
                      {d.owner_name ?? '—'}
                    </span>
                  </div>

                  {/* The number that matters, then its breakdown */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Amount value={d.total_debt} className="text-[15px] text-[#e5484d]" />
                    <span className="text-[12.5px] text-ink-3 roomy:text-[11.5px]">
                      ניהול <Amount value={d.management_fees} className="text-[12.5px] text-brand" />
                    </span>
                    <span className="text-[12.5px] text-ink-3 roomy:text-[11.5px]">
                      מים <Amount value={d.hot_water_debt} className="text-[12.5px] text-[#7c5cfc]" />
                    </span>
                  </div>

                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <LegalStatusPill name={d.legal_status_name} color={d.legal_status_color} />
                    <DocIndicator count={d.doc_count} lastAt={d.last_doc_at} />
                    {isArchivedTab && (
                      <span className="text-[12.5px] text-ink-3 roomy:text-[11.5px]" dir="ltr">
                        {formatDueDate(d.archived_at)}
                      </span>
                    )}
                  </div>

                  {isActionsTab && (d.next_action_description || d.next_action_date) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line-soft pt-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
                        {truncate(d.next_action_description, 40)}
                      </span>
                      <DueDateCell iso={d.next_action_date} />
                    </div>
                  )}
                </div>

                {/* Phone + row actions — above the stretched button so they stay
                    independently tappable. */}
                <div className="pointer-events-auto relative z-10 flex shrink-0 flex-col items-end gap-1.5">
                  <RowActions
                    debtorId={d.id}
                    apartment={d.apartment_number}
                    owner={d.owner_name}
                    canEdit={canArchive}
                    whatsappReason={!canSendWhatsapp ? 'אין הרשאה' : !waHasValidPhone ? 'אין מספר טלפון תקין' : null}
                    onWhatsApp={() => openWhatsapp(d)}
                    showCheck={isActionsTab && canArchive}
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
                  {phone && (
                    <a
                      href={`tel:${phone.replace(/\D/g, '')}`}
                      dir="ltr"
                      onClick={(e) => e.stopPropagation()}
                      className="font-num inline-flex h-11 items-center rounded-lg px-2 text-[12.5px] tabular-nums text-ink-2 hover:bg-row-hover"
                    >
                      {phone}
                    </a>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-hidden rounded-xl border border-line roomy:block">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-line">
            <TableRow className="bg-surface-2 hover:bg-surface-2">
              {canSendWhatsapp && (
                <TableHead className="h-11 w-10 px-4 text-center">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    aria-label="בחר הכל"
                  />
                </TableHead>
              )}
              <SortHead field="apt" label="מס׳ דירה" align="right" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="owner" label="שם בעל הדירה" align="right" currentSort={currentSort} onSort={handleSortClick} />
              <TableHead className="h-11 px-4 text-center text-[18px] font-semibold text-ink-2">טלפון</TableHead>
              <SortHead field="total_debt" label="סה״כ חוב" align="center" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="management_fees" label="דמי ניהול" align="center" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="hot_water_debt" label="מים חמים" align="center" currentSort={currentSort} onSort={handleSortClick} />
              <SortHead field="legal_status" label="מצב משפטי" align="center" currentSort={currentSort} onSort={handleSortClick} />
              {isActionsTab && (
                <>
                  <TableHead className="h-11 px-4 text-start text-[18px] font-semibold text-ink-2">פעולה לביצוע</TableHead>
                  <TableHead className="h-11 px-4 text-center text-[18px] font-semibold text-ink-2">תאריך יעד</TableHead>
                </>
              )}
              {isArchivedTab && (
                <TableHead className="h-11 px-4 text-center text-[18px] font-semibold text-ink-2">הועבר לארכיון</TableHead>
              )}
              <TableHead className="h-11 px-4 text-end text-[18px] font-semibold text-ink-2">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => {
              const phone = formatPhoneDisplay(getPrimaryPhone(d));
              // Clean fields hold one local number each; cleanPhoneField also
              // copes with any legacy compound value still in the column.
              const waHasValidPhone = Boolean(
                cleanPhoneField(d.phone_owner) || cleanPhoneField(d.phone_tenant),
              );
              return (
                <TableRow
                  key={d.id}
                  onClick={() => openPanel(d.id)}
                  className={cn(
                    'h-[46px] cursor-pointer border-b border-line-soft hover:bg-row-hover',
                    selectedIds.has(d.id) && 'bg-emerald-50/40 hover:bg-emerald-50/60',
                  )}
                >
                  {canSendWhatsapp && (
                    <TableCell className="w-10 px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(d.id)}
                        onCheckedChange={(v) => toggleOne(d.id, v === true)}
                        aria-label={`בחר דירה ${d.apartment_number}`}
                      />
                    </TableCell>
                  )}
                  <TableCell className="px-4 py-3 text-start text-sm font-num font-bold tabular-nums text-ink">
                    {d.apartment_number}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-start text-sm font-medium text-ink">
                    <span className="inline-flex items-center gap-1.5">
                      <span>{d.owner_name ?? <span className="text-ink-ghost">—</span>}</span>
                      <DocIndicator count={d.doc_count} lastAt={d.last_doc_at} />
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm font-num tabular-nums text-ink-2" dir="ltr">
                    {phone ?? <span className="text-ink-ghost">—</span>}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm">
                    <Amount value={d.total_debt} className="text-[#e5484d]" />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm">
                    <Amount value={d.management_fees} className="text-brand" />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm">
                    <Amount value={d.hot_water_debt} className="text-[#7c5cfc]" />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center">
                    <LegalStatusPill
                      name={d.legal_status_name}
                      color={d.legal_status_color}
                    />
                  </TableCell>
                  {isActionsTab && (
                    <>
                      <TableCell className="px-4 py-3 text-start text-sm text-slate-700">
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
                  <TableCell className="px-4 py-3 text-end" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      debtorId={d.id}
                      apartment={d.apartment_number}
                      owner={d.owner_name}
                      canEdit={canArchive}
                      whatsappReason={!canSendWhatsapp ? 'אין הרשאה' : !waHasValidPhone ? 'אין מספר טלפון תקין' : null}
                      onWhatsApp={() => openWhatsapp(d)}
                      showCheck={isActionsTab && canArchive}
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
              className={cn('inline-flex h-11 items-center gap-1 rounded-md border px-3 roomy:h-8 roomy:px-2', page <= 1 && 'pointer-events-none opacity-50')}
            >
              <ChevronRight className="h-4 w-4" />
              הקודם
            </Link>
            <Link
              href={page < totalPages ? `${pathname}?${withPage(searchParams, page + 1)}` : '#'}
              aria-disabled={page >= totalPages}
              className={cn('inline-flex h-11 items-center gap-1 rounded-md border px-3 roomy:h-8 roomy:px-2', page >= totalPages && 'pointer-events-none opacity-50')}
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
        canEdit={canArchive}
        canChangeStatus={canChangeStatus}
        canSendWhatsapp={canSendWhatsapp}
        canViewChips={canViewChips}
        canEditChips={canEditChips}
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

      <WhatsAppBulkSendPanel
        open={bulkOpen}
        recipients={bulkRecipients}
        onOpenChange={setBulkOpen}
        onDone={() => { setSelectedIds(new Set()); router.refresh(); }}
      />

      <AlertDialog
        open={markDone !== null}
        onOpenChange={(o) => { if (!o) setMarkDone(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>סמן את המשימה כבוצעה?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line text-start">
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
            <AlertDialogDescription className="text-start">
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
            <AlertDialogDescription className="text-start">
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
function toRecipient(d: Debtor): WhatsAppRecipient {
  return {
    id: d.id,
    apartment_number: d.apartment_number,
    owner_name: d.owner_name,
    tenant_name: d.tenant_name,
    phone_owner: d.phone_owner,
    phone_tenant: d.phone_tenant,
    total_debt: d.total_debt,
    management_fees: d.management_fees,
    hot_water_debt: d.hot_water_debt,
  };
}

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

// dd/MM/yyyy in Asia/Jerusalem (server runs UTC) — deterministic across SSR and
// hydration, so the cell text never differs by the UTC offset (React #418).
const dueDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatDueDate(input: unknown): string {
  const d = toDate(input);
  return d ? dueDateFmt.format(d) : '—';
}

function compareToToday(input: unknown): 'past' | 'today' | 'future' | null {
  const d = toDate(input);
  if (!d) return null;
  // Anchor the day bucket to Jerusalem so SSR (UTC) and hydration (browser tz)
  // agree — otherwise the past/today/future branch renders a different subtree.
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
  const today = todayInJerusalem();
  if (day === today) return 'today';
  return day < today ? 'past' : 'future';
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
  field, label, align, currentSort, onSort,
}: {
  field: SortField;
  label: string;
  align: 'right' | 'center' | 'left';
  currentSort: SortKey;
  onSort: (field: SortField) => void;
}) {
  const { field: curField, dir } = parseSortKey(currentSort);
  const isActive = curField === field;
  const ArrowIcon = isActive && dir === 'asc' ? ArrowUp : ArrowDown;

  const textAlign = align === 'right' ? 'text-start' : align === 'center' ? 'text-center' : 'text-end';
  // RTL justify: start = right, end = left — so the header label sits exactly
  // over the body cell content (which uses the matching text-align).
  const justify = align === 'right' ? 'justify-start' : align === 'center' ? 'justify-center' : 'justify-end';

  return (
    <TableHead className={cn('h-11 px-4', textAlign)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'group flex w-full items-center gap-1 text-[18px] font-semibold transition-colors',
          justify,
          isActive ? 'text-[#e5484d]' : 'text-ink-2 hover:text-ink',
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
  name, color,
}: { name: string | null; color: string | null }) {
  // Pill tinted by the status's chosen colour: soft fill + matching border +
  // a solid dot of the same hue, with the status name (incl. "רגיל"). Rows with
  // no status at all show a neutral em-dash.
  if (!name) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-ink-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-ghost" aria-hidden />
        —
      </span>
    );
  }
  const c = color ?? '#8a92a6';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold text-ink"
      style={{ backgroundColor: `${c}24`, borderColor: `${c}59` }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: c }} aria-hidden />
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
    <div dir="ltr" className="flex items-center justify-start gap-1.5">
      {showCheck && onCheck && (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <button
              type="button"
              onClick={onCheck}
              aria-label="סמן כבוצעה"
              className="inline-flex h-11 w-11 roomy:h-[30px] roomy:w-[30px] items-center justify-center rounded-lg text-[#16a34a] transition-colors hover:bg-[#e9fbf0]"
            >
              <CheckCircle2 className="h-[18px] w-[18px]" />
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
              className="inline-flex h-11 w-11 roomy:h-[30px] roomy:w-[30px] items-center justify-center rounded-lg text-[#f2620f] transition-colors hover:bg-[#fff0e6]"
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
              className="inline-flex h-11 w-11 roomy:h-[30px] roomy:w-[30px] items-center justify-center rounded-lg text-brand transition-colors hover:bg-brand-soft"
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
            className="inline-flex h-11 w-11 roomy:h-[30px] roomy:w-[30px] items-center justify-center rounded-lg text-[#16a34a] transition-colors hover:bg-[#e9fbf0] disabled:cursor-default disabled:text-ink-ghost disabled:hover:bg-transparent"
          >
            <MessageCircle className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{whatsappReason ?? 'שליחת WhatsApp'}</TooltipContent>
      </Tooltip>
    </div>
  );
}
