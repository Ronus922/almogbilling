'use client';

// Chip orders inside the issue window (13/11/2026). The separate order panel
// (ChipOrderSheet) and its "אשר" step are gone: an Orders-tab row opens the
// EXISTING issue window (IssueChipSheet) on the apartment, and the orderer's
// holder block carries
//   · "עדכן בכרטיס הדייר" — copies the block's name and phone to the tenants
//     list, in the slot of the order's role, ONLY on that click (after a
//     confirmation). Replaces the old per-field checkboxes of the approval;
//   · one "פרטי הזמנה" section per OPEN order of that person for the apartment
//     — the order's details, "שויכו X מתוך Y", and the order's buttons
//     ("מוכן לאיסוף" · "נאסף" · "דחה" · "מחק הזמנת בדיקה").
// Chips skin (DESIGN "מודול צ׳יפים"): the window's own tokens and tone
// families; confirmations are AlertDialogs (DESIGN §12).

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ClipboardList, ExternalLink, Loader2, UserPen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import {
  CHIP_ORDER_ROLE_LABEL, chipOrderStage, formatIls, isChipOrderOverdue, needsLease,
  type ChipOrderSection,
} from '@/lib/chipOrders/model';
import { ChipOrderStagePill, ChipOrderTestBadge, ChipOrderUnverifiedPhoneBadge } from './ChipOrderStatusPill';

const DATE_ONLY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const BTN = 'h-11 gap-2 rounded-[11px] px-5 text-[14px] font-bold disabled:opacity-50';
const BTN_RED_OUTLINE =
  'h-11 rounded-[11px] border-[1.5px] border-[var(--chip-red-border)] bg-[var(--chip-panel)] px-5 text-[14px] font-bold text-[var(--chip-red-ink)] hover:bg-[var(--chip-red-soft)]';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-[120px] shrink-0 text-[12.5px] font-bold text-[var(--chip-ink-soft)]">{label}</span>
      <span className="min-w-0 break-words text-[14px] font-semibold text-[var(--chip-ink)]">{children}</span>
    </div>
  );
}

async function postJson(url: string, body?: unknown, method = 'POST') {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; refund_label?: string; refund_note?: string | null };
  if (!res.ok) throw new Error(data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה');
  return data;
}

// ── "פרטי הזמנה" — one open order of the block's person ───────────────────

export function ChipOrderSectionCard({
  section, pending, canEditOrders, disabled, onChanged, onModalChange,
}: {
  section: ChipOrderSection;
  /** New numbers in the window that this save would link to the section. */
  pending: number;
  /** chips_orders_manage:edit — the order's buttons. */
  canEditOrders: boolean;
  /** The window is saving. */
  disabled: boolean;
  onChanged: () => void;
  /** A confirmation dialog of this section opened / closed (the window then
   *  keeps its own Escape-to-close away). */
  onModalChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const s = section;
  const linked = s.chips_linked;
  const stage = chipOrderStage(s.status, linked, s.chips_count);
  const overdue = isChipOrderOverdue(s);
  const over = linked + pending > s.chips_count;
  const assigning = s.status === 'paid' || s.status === 'approved';

  function setModal(kind: 'reject' | 'delete', open: boolean) {
    if (kind === 'reject') setRejectOpen(open);
    else setDeleteOpen(open);
    onModalChange(open);
  }

  async function act(key: string, run: () => Promise<{ refund_label?: string; refund_note?: string | null }>, okMsg: string): Promise<boolean> {
    setBusy(key);
    try {
      const data = await run();
      toast.success(okMsg, data.refund_label ? { description: `זיכוי: ${data.refund_label}${data.refund_note ? ` — ${data.refund_note}` : ''}` } : undefined);
      onChanged();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-testid="chip-order-section"
      className="flex flex-col gap-3 rounded-[13px] border-[1.5px] border-[var(--chip-brand-border)] bg-[var(--chip-panel-alt)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[14px] font-extrabold text-[var(--chip-ink)]">
          <ClipboardList className="h-4 w-4 text-[var(--chip-brand)]" />
          פרטי הזמנה
        </span>
        <span className="chip-num text-[13px] font-bold text-[var(--chip-ink-muted)]">{s.order_number}</span>
        {s.is_test && <ChipOrderTestBadge />}
        {!s.phone_verified && <ChipOrderUnverifiedPhoneBadge />}
      </div>

      <div className="flex flex-col gap-2.5">
        <Row label="מייל">{s.email}</Row>
        <Row label="כתובת מגורים">{s.address}</Row>
        <Row label="מספר הזמנה"><span className="chip-num">{s.order_number}</span></Row>
        <Row label="כמות שהוזמנה">{s.chips_count}</Row>
        <Row label="סכום ששולם">{s.is_test ? 'בדיקה, ללא חיוב' : formatIls(s.total)}</Row>
        {needsLease(s.role) && (
          <Row label={s.role === 'operator' ? 'הסכם ניהול' : 'חוזה'}>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {s.lease_file_key ? (
                <a
                  href={`/api/files/chip-order-leases/${s.lease_file_key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="chip-order-lease-link"
                  className="inline-flex min-h-11 items-center gap-1.5 text-[var(--chip-brand)] underline-offset-2 hover:underline"
                >
                  <ExternalLink className="h-4 w-4" />
                  צפייה בחוזה
                </a>
              ) : (
                <span className="text-[var(--chip-ink-soft)]">לא צורף</span>
              )}
              <span className="text-[13px] text-[var(--chip-ink-muted)]">
                סיום חוזה: {s.lease_end_date ? DATE_ONLY.format(new Date(`${s.lease_end_date}T12:00:00Z`)) : '—'}
              </span>
            </span>
          </Row>
        )}
        <Row label="סטטוס">
          <ChipOrderStagePill stage={stage} linked={linked} ordered={s.chips_count} overdue={overdue} />
        </Row>
        {assigning && s.due_at && (
          <Row label="יעד להכנה">
            <span className={overdue ? 'text-[var(--chip-red-ink)]' : undefined}>{DATE_TIME.format(new Date(s.due_at))}</span>
          </Row>
        )}
      </div>

      <div data-testid="chip-order-progress" className="text-[13px] font-bold text-[var(--chip-ink-muted)]">
        שויכו {linked} מתוך {s.chips_count}
        {pending > 0 && <span className="font-semibold text-[var(--chip-amber-ink)]"> · {pending} ממתינים לשמירה</span>}
      </div>
      {over && (
        <p role="alert" className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[12.5px] font-semibold text-[var(--chip-amber-ink)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          נוספו יותר צ׳יפים ממה שהוזמן ({linked + pending} מתוך {s.chips_count}). אפשר לשמור — הצ׳יפים העודפים יקושרו גם הם להזמנה הזו.
        </p>
      )}
      {s.other_apartments.length > 0 && (
        <p className="text-[12.5px] font-semibold text-[var(--chip-ink-soft)]">
          ההזמנה כוללת גם את {s.other_apartments.length === 1 ? 'דירה' : 'דירות'} {s.other_apartments.join(', ')}. „מוכן לאיסוף”, „נאסף” ו„דחה” חלים על ההזמנה כולה.
        </p>
      )}

      {canEditOrders && (
        <div className="flex flex-wrap items-center gap-2">
          {assigning && (
            <Button
              type="button"
              disabled={disabled || busy !== null || !s.order_all_linked}
              title={s.order_all_linked ? undefined : 'יש לשייך ולשמור קודם את כל הצ׳יפים שהוזמנו'}
              onClick={() => void act('ready', () => postJson(`/api/chip-orders/${s.order_id}/ready`), 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')}
              className={cn(BTN, 'bg-[var(--chip-brand)] text-white hover:bg-[var(--chip-brand-hover)]')}
            >
              {busy === 'ready' && <Loader2 className="h-4 w-4 animate-spin" />}
              מוכן לאיסוף
            </Button>
          )}
          {s.status === 'ready' && (
            <Button
              type="button"
              disabled={disabled || busy !== null}
              onClick={() => void act('collected', () => postJson(`/api/chip-orders/${s.order_id}/collected`), 'סומן כנאסף')}
              className={cn(BTN, 'bg-[var(--chip-green)] text-white hover:opacity-90')}
            >
              {busy === 'collected' && <Loader2 className="h-4 w-4 animate-spin" />}
              נאסף
            </Button>
          )}
          {assigning && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy !== null}
              onClick={() => setModal('reject', true)}
              className={BTN_RED_OUTLINE}
            >
              דחה
            </Button>
          )}
          {s.is_test && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy !== null}
              onClick={() => setModal('delete', true)}
              data-testid="chip-order-delete-test"
              className={BTN_RED_OUTLINE}
            >
              מחק הזמנת בדיקה
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={rejectOpen} onOpenChange={(o) => { if (!busy) setModal('reject', o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>לדחות את הזמנה {s.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {s.is_test
                ? 'הזמנת בדיקה: היא תסומן „נדחה” בלי פנייה ל-Grow (לא היה חיוב — הזיכוי „לא נדרש (בדיקה)”). המזמין יקבל מייל ווואטסאפ עם הסיבה.'
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
                const ok = await act('reject', () => postJson(`/api/chip-orders/${s.order_id}/reject`, { reason: rejectReason.trim() }), 'ההזמנה נדחתה');
                if (ok) { setModal('reject', false); setRejectReason(''); }
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" />}
              {s.is_test ? 'דחה' : 'דחה והחזר תשלום'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(o) => { if (!busy) setModal('delete', o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הזמנת הבדיקה {s.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              ההזמנה, הדירות שלה, ההודעות וקובצי החוזה יימחקו לצמיתות. צ׳יפים שהונפקו לה נשארים במודול הצ׳יפים, רק בלי הקישור להזמנה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {linked > 0 && (
            <p role="alert" className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[13.5px] font-semibold text-[var(--chip-amber-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {linked === 1 ? 'לדירה הזו צ׳יפ פעיל אחד מההזמנה' : `לדירה הזו ${linked} צ׳יפים פעילים מההזמנה`}. הם לא יימחקו — אפשר להשבית אותם בבלוק.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await act('delete', () => postJson(`/api/chip-orders/${s.order_id}`, undefined, 'DELETE'), 'הזמנת הבדיקה נמחקה');
                if (ok) setModal('delete', false);
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'delete' && <Loader2 className="h-4 w-4 animate-spin" />}
              מחק הזמנת בדיקה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── "עדכן בכרטיס הדייר" ────────────────────────────────────────────────────

export function HolderRegistryButton({
  itemId, apartmentNumber, role, name, phone, canWriteContacts, disabled, onDone, onModalChange,
}: {
  /** A line of the block's order — the server resolves the apartment and the
   *  slot (the order's role) from it. */
  itemId: string;
  apartmentNumber: string;
  role: ChipOrderSection['role'];
  /** The block's name and phone, as typed now. */
  name: string;
  phone: string;
  /** contacts:edit (the server checks it again). */
  canWriteContacts: boolean;
  disabled: boolean;
  onDone: () => void;
  onModalChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = name.trim();
  const p = phone.trim();
  const phoneOk = !p || validatePhone(p).valid;
  const ready = canWriteContacts && (n !== '' || p !== '') && phoneOk;
  const slot = CHIP_ORDER_ROLE_LABEL[role];

  function setModal(o: boolean) {
    setOpen(o);
    onModalChange(o);
  }

  async function write() {
    setBusy(true);
    try {
      await postJson(`/api/chip-orders/items/${itemId}/registry`, { name: n || null, phone: p || null });
      toast.success(`כרטיס הדייר של דירה ${apartmentNumber} עודכן`);
      setModal(false);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !ready}
        onClick={() => setModal(true)}
        data-testid="chip-holder-registry-update"
        className="h-11 w-fit gap-2 rounded-[11px] border-[1.5px] border-[var(--chip-brand-border)] bg-[var(--chip-panel)] px-4 text-[13.5px] font-bold text-[var(--chip-brand-ink)] hover:bg-[var(--chip-brand-soft)]"
      >
        <UserPen className="h-4 w-4" />
        עדכן בכרטיס הדייר
      </Button>
      {!canWriteContacts && (
        <span className="text-[12px] font-semibold text-[var(--chip-ink-soft)]">עדכון כרטיס הדייר דורש הרשאת עריכה ברשימת הדיירים.</span>
      )}
      {canWriteContacts && !phoneOk && (
        <span className="text-[12px] font-semibold text-red-500">⚠️ מספר הטלפון בבלוק לא תקין</span>
      )}

      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setModal(o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>לעדכן את כרטיס הדייר של דירה {apartmentNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              {`רשימת הדיירים, בתא „${slot}”, תתעדכן לערכים שבבלוק. שדה ריק לא נכתב ולא מוחק את הקיים.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5 rounded-[11px] border border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-3 text-[13.5px] font-semibold text-[var(--chip-ink)]">
            {n && <span>שם: {n}</span>}
            {p && <span>טלפון: <span className="chip-num">{p}</span></span>}
          </div>
          {p && role === 'owner' && (
            <p role="alert" className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[13px] font-semibold text-[var(--chip-amber-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              טלפון של בעלים ברשימת הדיירים פותח למספר הזה את פורטל הדירה, ומאותו רגע הוא רואה את נתוניה.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void write()}
              className="h-11 gap-2 bg-[var(--chip-brand)] px-4 text-white hover:bg-[var(--chip-brand-hover)]"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              עדכן בכרטיס הדייר
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
