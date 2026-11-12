'use client';

// The order screen of /chips → "הזמנות" (12/11/2026). A side panel in the
// chips skin (declared exception, DESIGN "מודול צ׳יפים") — the same header,
// section cards and footer order as the issue window (IssueChipSheet), which
// stays THE ONLY place chips are issued: "שייך צ׳יפים" closes this panel and
// opens that window prefilled with the apartment, the holder and the order
// line. Confirmations (reject) use an AlertDialog, per DESIGN §12.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, BellRing, Building2, Check, ExternalLink, FileText, KeyRound, Loader2, Mail,
  MessageCircle, Receipt, User, X,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { toPortalE164, e164ToLocal } from '@/lib/portal/phone';
import {
  CHIP_ORDER_MATCH_LABEL, CHIP_ORDER_REFUND_LABEL, CHIP_ORDER_ROLE_LABEL, CHIP_ORDER_STATUS_LABEL,
  activeLinked, allChipsLinked, formatIls, isChipOrderOverdue,
  type ChipOrderApprovalFields, type ChipOrderDetail, type ChipOrderItemDetail, type ChipOrderMatchStatus,
} from '@/lib/chipOrders/model';
import { ChipSection, LABEL_CLS } from './ChipSection';
import { ChipOrderStatusPill, ChipOrderTestBadge } from './ChipOrderStatusPill';

export interface AssignRequest {
  orderId: string;
  orderNumber: number;
  item: ChipOrderItemDetail;
  role: ChipOrderDetail['role'];
  holderName: string;
  holderPhone: string;
}

const MATCH_TONE: Record<ChipOrderMatchStatus, string> = {
  matched: 'bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)] border-[var(--chip-green-border)]',
  review: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)] border-[var(--chip-amber-border)]',
  unassigned: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet-ink)] border-[var(--chip-violet-border)]',
  document_review: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)] border-[var(--chip-brand-border)]',
};

const DATE_TIME = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const DATE_ONLY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmt = (iso: string | null) => (iso ? DATE_TIME.format(new Date(iso)) : '—');

const NOTIFY_KIND: Record<string, string> = { paid: 'התקבל ושולם', approved: 'אושר', ready: 'מוכן לאיסוף', rejected: 'נדחה' };

type FieldKey = 'name' | 'phone' | 'email';

/** Nothing is ticked by default — writing to the tenants list is always a
 *  person's decision. A phone written there also opens the apartment's owners
 *  portal to that number (the roster triggers), so it must never be implied. */
function defaultChecks(order: ChipOrderDetail): Record<string, Record<FieldKey, boolean>> {
  const next: Record<string, Record<FieldKey, boolean>> = {};
  for (const item of order.items) next[item.id] = { name: false, phone: false, email: false };
  return next;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-[120px] shrink-0 text-[12.5px] font-bold text-[var(--chip-ink-soft)]">{label}</span>
      <span className="min-w-0 break-words text-[14px] font-semibold text-[var(--chip-ink)]">{children}</span>
    </div>
  );
}

export function ChipOrderSheet({
  orderId, open, onOpenChange, canEdit, canWriteContacts, onAssign, onChanged,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canEdit: boolean;
  /** contacts:edit — ticking a field writes to the tenants list. */
  canWriteContacts: boolean;
  onAssign: (req: AssignRequest) => void;
  onChanged: () => void;
}) {
  const [order, setOrder] = useState<ChipOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, Record<FieldKey, boolean>>>({});
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/chip-orders/${orderId}`, { credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { order?: ChipOrderDetail; error?: string };
      if (!res.ok || !data.order) throw new Error(data.error ?? 'ההזמנה לא נמצאה');
      setOrder(data.order);
      setChecks(defaultChecks(data.order));
    } catch (e) {
      toast.error((e as Error).message);
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    if (open && orderId) void load();
    if (!open) {
      setRejectOpen(false);
      setRejectReason('');
      setDeleteOpen(false);
    }
  }, [open, orderId, load]);

  async function act(path: string, body?: unknown, okMsg?: string): Promise<boolean> {
    if (!orderId) return false;
    setBusy(path);
    try {
      const res = await fetch(`/api/chip-orders/${orderId}/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; refund_label?: string; refund_note?: string | null };
      if (!res.ok) throw new Error(data.error ?? 'הפעולה נכשלה');
      toast.success(okMsg ?? 'עודכן', data.refund_label ? { description: `זיכוי: ${data.refund_label}${data.refund_note ? ` — ${data.refund_note}` : ''}` } : undefined);
      onChanged();
      await load();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** "מחק הזמנת בדיקה" — test orders only (the server refuses any other). */
  async function deleteTestOrder(): Promise<void> {
    if (!orderId) return;
    setBusy('delete');
    try {
      const res = await fetch(`/api/chip-orders/${orderId}`, { method: 'DELETE', credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error === 'not_found' ? 'הזמנת הבדיקה לא נמצאה' : data.error ?? 'המחיקה נכשלה');
      toast.success('הזמנת הבדיקה נמחקה');
      setDeleteOpen(false);
      onChanged();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function approve() {
    if (!order) return;
    const fields: ChipOrderApprovalFields[] = order.items.map((i) => ({
      item_id: i.id,
      name: checks[i.id]?.name ?? false,
      phone: checks[i.id]?.phone ?? false,
      email: checks[i.id]?.email ?? false,
    }));
    void act('approve', { fields }, 'ההזמנה אושרה — נשלחה הודעה למזמין');
  }

  const linkedAll = useMemo(() => (order ? allChipsLinked(order.items) : false), [order]);
  const activeChips = useMemo(() => (order ? order.items.reduce((n, i) => n + activeLinked(i), 0) : 0), [order]);
  const overdue = order ? isChipOrderOverdue(order) : false;

  const orderPhone = order?.phone_e164 ?? '';
  const formValue = (k: FieldKey): string =>
    !order ? '' : k === 'name' ? order.full_name : k === 'phone' ? e164ToLocal(orderPhone) : order.email;
  const sameAs = (k: FieldKey, reg: string | null): boolean => {
    if (!order || !reg?.trim()) return false;
    if (k === 'phone') return toPortalE164(reg) === orderPhone;
    if (k === 'email') return reg.trim().toLowerCase() === order.email.toLowerCase();
    return reg.trim() === order.full_name.trim();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="chips-skin w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-[var(--chip-panel)]"
        >
          <SheetHeader className="flex-none gap-2 bg-[image:var(--chip-header-gradient)] px-[28px] py-[22px] text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-[21px] font-extrabold tracking-[-0.02em] text-white">
                  {order ? `הזמנת צ׳יפים ${order.order_number}` : 'הזמנת צ׳יפים'}
                </SheetTitle>
                <p className="mt-[4px] text-[13.5px] font-medium text-white/[0.82]">
                  {order
                    ? `${order.is_test ? 'הזמנת בדיקה · ' : ''}${CHIP_ORDER_STATUS_LABEL[order.status]} · ${formatIls(order.total)}`
                    : 'טוען…'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="סגור"
                className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[11px] border border-white/25 bg-white/12 text-white transition-colors hover:bg-white/22"
              >
                <X className="h-[18px] w-[18px]" strokeWidth={2.4} />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-[var(--chip-bg)] p-[22px]">
            {loading && !order ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-28 animate-pulse rounded-[16px] bg-white/70" />
                ))}
              </div>
            ) : order ? (
              <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
                {/* Status strip */}
                <div className="flex flex-wrap items-center gap-2 rounded-[13px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-4">
                  {order.is_test && <ChipOrderTestBadge />}
                  <ChipOrderStatusPill status={order.status} overdue={overdue} />
                  {order.due_at && order.status === 'approved' && (
                    <span className={cn('text-[13px] font-bold', overdue ? 'text-[var(--chip-red-ink)]' : 'text-[var(--chip-ink-muted)]')}>
                      יעד להכנה: {fmt(order.due_at)}
                    </span>
                  )}
                  {order.status === 'rejected' && (
                    <span className="text-[13px] font-bold text-[var(--chip-ink-muted)]">
                      {order.refund_status ? `זיכוי: ${CHIP_ORDER_REFUND_LABEL[order.refund_status]}` : ''}
                    </span>
                  )}
                </div>

                {order.status === 'rejected' && (
                  <div className="rounded-[11px] border border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] p-4 text-[13px] font-semibold text-[var(--chip-red-ink)]">
                    <p>סיבת הדחייה: {order.reject_reason}</p>
                    {order.refund_note && <p className="mt-1">פרטי הזיכוי: {order.refund_note}</p>}
                  </div>
                )}

                <ChipSection title="פרטי המזמין" icon={User} iconTone="violet">
                  <div className="flex flex-col gap-2.5 px-1">
                    <Row label="שם מלא">{order.full_name}</Row>
                    <Row label="טלפון">
                      <a href={`tel:${e164ToLocal(order.phone_e164)}`} className="chip-num text-[var(--chip-brand)] underline-offset-2 hover:underline">
                        {e164ToLocal(order.phone_e164)}
                      </a>
                    </Row>
                    <Row label="מייל">{order.email}</Row>
                    <Row label="כתובת מגורים">{order.address}</Row>
                    <Row label="מזמין כ">{CHIP_ORDER_ROLE_LABEL[order.role]}</Row>
                    <Row label="שולם">{fmt(order.paid_at)}</Row>
                  </div>
                </ChipSection>

                <ChipSection title="תשלום וחשבונית" icon={Receipt} iconTone="green">
                  <div className="flex flex-col gap-2.5 px-1">
                    <Row label="סכום">{formatIls(order.total)}</Row>
                    <Row label="אסמכתא"><span className="chip-num">{order.grow_asmachta ?? '—'}</span></Row>
                    <Row label="חשבונית / קבלה">
                      {order.invoice_url ? (
                        <a
                          href={order.invoice_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-[44px] items-center gap-1.5 text-[var(--chip-brand)] underline-offset-2 hover:underline"
                        >
                          <ExternalLink className="h-4 w-4" />
                          פתח {order.invoice_number ? `(${order.invoice_number})` : ''}
                        </a>
                      ) : (
                        <span className="text-[var(--chip-ink-soft)]">
                          {order.is_test ? 'אין — הזמנת בדיקה, ללא חיוב' : 'טרם התקבלה מ-Grow'}
                        </span>
                      )}
                    </Row>
                  </div>
                </ChipSection>

                {order.items.map((item) => {
                  const remaining = Math.max(0, item.chips_count - activeLinked(item));
                  const reg = item.registry;
                  return (
                    <ChipSection
                      key={item.id}
                      title={`דירה ${item.apartment_number}`}
                      sub={`${item.chips_count} צ׳יפים · ${formatIls(item.line_total)}`}
                      icon={Building2}
                      iconTone="blue"
                    >
                      <div className="flex flex-col gap-4 px-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn('inline-flex h-[24px] items-center rounded-[7px] border px-2.5 text-[12px] font-bold', MATCH_TONE[item.match_status])}>
                            {CHIP_ORDER_MATCH_LABEL[item.match_status]}
                          </span>
                          <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                            עד {item.threshold} צ׳יפים ב-{formatIls(item.unit_price)} · מעליהם {formatIls(item.price_above)} לצ׳יפ
                          </span>
                        </div>

                        {item.lease_file_key && (
                          <div className="flex flex-wrap items-center gap-3 rounded-[11px] border border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-3">
                            <FileText className="h-5 w-5 shrink-0 text-[var(--chip-brand)]" />
                            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--chip-ink)]" title={item.lease_file_name ?? ''}>
                              {item.lease_file_name}
                            </span>
                            {item.lease_end_date && (
                              <span className="text-[12.5px] font-bold text-[var(--chip-ink-muted)]">
                                סיום חוזה: {DATE_ONLY.format(new Date(`${item.lease_end_date}T12:00:00Z`))}
                              </span>
                            )}
                            <a
                              href={`/api/files/chip-order-leases/${item.lease_file_key}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex h-11 items-center gap-1.5 rounded-[10px] border-[1.5px] border-[var(--chip-brand-border)] bg-white px-4 text-[13px] font-bold text-[var(--chip-brand-ink)] hover:bg-[var(--chip-brand-soft)]"
                            >
                              צפייה בחוזה
                            </a>
                          </div>
                        )}

                        {/* Form ↔ tenants list — only while the order awaits approval */}
                        {order.status === 'paid' && (
                          <div className="overflow-hidden rounded-[11px] border border-[var(--chip-border)]">
                            <div className="grid grid-cols-[56px_1fr_1fr] gap-2 bg-[var(--chip-panel-alt)] px-3 py-2 text-[12px] font-bold text-[var(--chip-ink-soft)] sm:grid-cols-[64px_1fr_1fr_96px]">
                              <span>שדה</span>
                              <span>בטופס</span>
                              <span>ברשימת הדיירים ({CHIP_ORDER_ROLE_LABEL[order.role]})</span>
                              <span className="hidden sm:block">לכתוב?</span>
                            </div>
                            {!canWriteContacts && (
                              <p className="border-t border-[var(--chip-border)] px-3 py-2 text-[12.5px] font-semibold text-[var(--chip-ink-soft)]">
                                כתיבה לרשימת הדיירים דורשת הרשאת עריכה ברשימת הדיירים.
                              </p>
                            )}
                            {(['name', 'phone', 'email'] as FieldKey[]).map((k) => {
                              const regValue = k === 'name' ? reg.name : k === 'phone' ? reg.phone : reg.email;
                              const disabled = !canEdit || !canWriteContacts || (k === 'email' && !reg.emailSupported) || sameAs(k, regValue);
                              const label = k === 'name' ? 'שם' : k === 'phone' ? 'טלפון' : 'מייל';
                              return (
                                <label
                                  key={k}
                                  className="grid min-h-[44px] grid-cols-[56px_1fr_1fr] items-center gap-2 border-t border-[var(--chip-border)] px-3 py-2 text-[13px] sm:grid-cols-[64px_1fr_1fr_96px]"
                                >
                                  <span className="font-bold text-[var(--chip-ink-muted)]">{label}</span>
                                  <span className="min-w-0 break-words font-semibold text-[var(--chip-ink)]">{formValue(k)}</span>
                                  <span className="min-w-0 break-words font-semibold text-[var(--chip-ink-muted)]">
                                    {k === 'email' && !reg.emailSupported ? 'אין שדה מייל למפעיל' : regValue?.trim() || '—'}
                                    {sameAs(k, regValue) && <span className="ms-1.5 text-[11.5px] font-bold text-[var(--chip-green-ink)]">זהה</span>}
                                  </span>
                                  <span className="col-span-3 flex items-center gap-2 sm:col-span-1">
                                    <Checkbox
                                      checked={!disabled && (checks[item.id]?.[k] ?? false)}
                                      disabled={disabled}
                                      onCheckedChange={(v) =>
                                        setChecks((prev) => ({ ...prev, [item.id]: { ...prev[item.id], [k]: v === true } }))
                                      }
                                      aria-label={`לכתוב ${label} לדירה ${item.apartment_number}`}
                                    />
                                    <span className="text-[12px] font-semibold text-[var(--chip-ink-soft)] sm:hidden">לכתוב לרשימת הדיירים</span>
                                  </span>
                                  {k === 'phone' && checks[item.id]?.phone && !disabled && (
                                    <span className="col-span-3 flex items-start gap-1.5 text-[12px] font-bold text-[var(--chip-amber-ink)] sm:col-span-4">
                                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                      הטלפון ייכנס לרשימת הדיירים — ומאותו רגע המספר הזה נכנס לפורטל הדירה ורואה את נתוניה.
                                    </span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {/* Linked chips */}
                        <div className="flex flex-col gap-2">
                          <span className={LABEL_CLS}>
                            <KeyRound className="h-3.5 w-3.5" />
                            צ׳יפים פעילים ששויכו: {activeLinked(item)} מתוך {item.chips_count}
                          </span>
                          {item.linked_chips.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {item.linked_chips.map((c) => (
                                <span
                                  key={c.id}
                                  className={cn(
                                    'chip-num inline-flex h-[26px] items-center rounded-[7px] border px-2.5 text-[12.5px] font-bold',
                                    c.status === 'active'
                                      ? 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]'
                                      : 'border-dashed border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)] line-through',
                                  )}
                                >
                                  {c.chip_number}
                                </span>
                              ))}
                            </div>
                          )}
                          {canEdit && order.status === 'approved' && remaining > 0 && (
                            <Button
                              type="button"
                              onClick={() =>
                                onAssign({
                                  orderId: order.id,
                                  orderNumber: order.order_number,
                                  item,
                                  role: order.role,
                                  holderName: order.full_name,
                                  holderPhone: e164ToLocal(order.phone_e164),
                                })
                              }
                              className="h-11 w-fit gap-2 rounded-[11px] bg-[var(--chip-brand)] px-5 text-[14px] font-bold text-white hover:bg-[var(--chip-brand-hover)]"
                            >
                              <KeyRound className="h-4 w-4" />
                              שייך צ׳יפים ({remaining})
                            </Button>
                          )}
                        </div>
                      </div>
                    </ChipSection>
                  );
                })}

                <ChipSection title="הודעות למזמין" sub="מייל וגם וואטסאפ בכל שינוי סטטוס" icon={BellRing} iconTone="amber">
                  {order.notifications.length === 0 ? (
                    <p className="px-1 text-[13px] font-medium text-[var(--chip-ink-soft)]">עדיין לא נשלחו הודעות.</p>
                  ) : (
                    <ul className="flex flex-col gap-2 px-1">
                      {order.notifications.map((n) => (
                        <li key={n.id} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[var(--chip-panel-alt)] p-3 text-[13px]">
                          {n.channel === 'email' ? <Mail className="h-4 w-4 text-[var(--chip-ink-muted)]" /> : <MessageCircle className="h-4 w-4 text-[var(--chip-ink-muted)]" />}
                          <span className="font-bold text-[var(--chip-ink)]">{NOTIFY_KIND[n.kind] ?? n.kind}</span>
                          <span className="text-[var(--chip-ink-muted)]">{n.channel === 'email' ? 'מייל' : 'וואטסאפ'}</span>
                          <span
                            className={cn(
                              'inline-flex h-[22px] items-center gap-1 rounded-[6px] px-2 text-[11.5px] font-bold',
                              n.status === 'sent'
                                ? 'bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]'
                                : n.status === 'failed'
                                  ? 'bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)]'
                                  : 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
                            )}
                          >
                            {n.status === 'sent' ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                            {n.status === 'sent' ? 'נשלח' : n.status === 'failed' ? 'נכשל' : 'לא נשלח'}
                          </span>
                          <span className="chip-num ms-auto text-[12px] text-[var(--chip-ink-soft)]">{fmt(n.created_at)}</span>
                          {n.error && <span className="basis-full text-[12.5px] font-semibold text-[var(--chip-red-ink)]">{n.error}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </ChipSection>
              </div>
            ) : null}
          </div>

          {/* Footer — primary at start, like the issue window */}
          <div className="flex flex-none flex-col-reverse gap-3 border-t border-[var(--chip-border)] bg-[var(--chip-panel)] px-6 py-[15px] pb-[max(15px,env(safe-area-inset-bottom))] sm:flex-row sm:items-center">
            {order && canEdit && (
              <div className="flex flex-wrap items-center gap-3">
                {order.status === 'paid' && (
                  <Button
                    type="button"
                    onClick={approve}
                    disabled={busy !== null}
                    className="h-[46px] gap-2 rounded-[11px] bg-[var(--chip-brand)] px-[26px] text-[15px] font-bold text-white hover:bg-[var(--chip-brand-hover)] disabled:opacity-50"
                  >
                    {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" />}
                    אשר
                  </Button>
                )}
                {order.status === 'approved' && (
                  <Button
                    type="button"
                    onClick={() => void act('ready', undefined, 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')}
                    disabled={busy !== null || !linkedAll}
                    title={linkedAll ? undefined : 'יש לשייך קודם את כל הצ׳יפים שהוזמנו'}
                    className="h-[46px] gap-2 rounded-[11px] bg-[var(--chip-brand)] px-[26px] text-[15px] font-bold text-white hover:bg-[var(--chip-brand-hover)] disabled:opacity-50"
                  >
                    {busy === 'ready' && <Loader2 className="h-4 w-4 animate-spin" />}
                    מוכן לאיסוף
                  </Button>
                )}
                {order.status === 'ready' && (
                  <Button
                    type="button"
                    onClick={() => void act('collected', undefined, 'סומן כנאסף')}
                    disabled={busy !== null}
                    className="h-[46px] gap-2 rounded-[11px] bg-[var(--chip-green)] px-[26px] text-[15px] font-bold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy === 'collected' && <Loader2 className="h-4 w-4 animate-spin" />}
                    נאסף
                  </Button>
                )}
                {(order.status === 'paid' || order.status === 'approved') && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRejectOpen(true)}
                    disabled={busy !== null}
                    className="h-[46px] rounded-[11px] border-[1.5px] border-[var(--chip-red-border)] bg-[var(--chip-panel)] px-[22px] text-[14px] font-bold text-[var(--chip-red-ink)] hover:bg-[var(--chip-red-soft)]"
                  >
                    דחה
                  </Button>
                )}
                {order.is_test && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDeleteOpen(true)}
                    disabled={busy !== null}
                    data-testid="chip-order-delete-test"
                    className="h-[46px] rounded-[11px] border-[1.5px] border-[var(--chip-red-border)] bg-[var(--chip-panel)] px-[22px] text-[14px] font-bold text-[var(--chip-red-ink)] hover:bg-[var(--chip-red-soft)]"
                  >
                    מחק הזמנת בדיקה
                  </Button>
                )}
              </div>
            )}
            <span className="hidden flex-1 sm:block" />
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="h-[46px] rounded-[11px] border-[1.5px] border-[var(--chip-border-strong)] bg-[var(--chip-panel)] px-[22px] text-[14px] font-bold text-[var(--chip-ink)] hover:bg-[var(--chip-hover)]"
            >
              סגור
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={rejectOpen} onOpenChange={(o) => { if (!busy) setRejectOpen(o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>לדחות את ההזמנה?</AlertDialogTitle>
            <AlertDialogDescription>
              {order?.is_test
                ? 'הזמנת בדיקה: היא תסומן „נדחה” בלי פנייה ל-Grow (לא היה חיוב — הזיכוי „לא נדרש”). המזמין יקבל מייל ווואטסאפ עם הסיבה.'
                : 'ההזמנה תסומן „נדחה” ויתבקש זיכוי מלא מ-Grow. המזמין יקבל מייל ווואטסאפ עם הסיבה ומצב הזיכוי.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="סיבת הדחייה (תישלח למזמין)"
            maxLength={500}
            className="min-h-[96px] px-3 py-2"
            aria-label="סיבת הדחייה"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null || rejectReason.trim().length < 2}
              onClick={async () => {
                const ok = await act('reject', { reason: rejectReason.trim() }, 'ההזמנה נדחתה');
                if (ok) setRejectOpen(false);
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" />}
              {order?.is_test ? 'דחה' : 'דחה והחזר תשלום'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(o) => { if (!busy) setDeleteOpen(o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הזמנת הבדיקה?</AlertDialogTitle>
            <AlertDialogDescription>
              ההזמנה, הדירות שלה, ההודעות וקובצי החוזה יימחקו לצמיתות. צ׳יפים שהונפקו לה נשארים במודול הצ׳יפים, רק בלי הקישור להזמנה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {activeChips > 0 && (
            <p role="alert" className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[13.5px] font-semibold text-[var(--chip-amber-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {activeChips === 1 ? 'להזמנה צ׳יפ פעיל אחד' : `להזמנה ${activeChips} צ׳יפים פעילים`}. הם לא יימחקו — השביתו אותם בחלון ההנפקה של הדירה.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void deleteTestOrder()}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'delete' && <Loader2 className="h-4 w-4 animate-spin" />}
              מחק הזמנת בדיקה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
