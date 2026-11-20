'use client';

// "עדכן בכרטיס הדייר" (13/11/2026; per block from 20/11/2026) — a button in a
// holder block of the issue window opened from an order. It copies the block's
// NAME and PHONE into the tenants list of the block's apartment, in the slot of
// the BLOCK's role (owner_* / tenant_* / operator_*), ONLY on that click and
// after a confirmation (an owner phone opens the owners portal — the dialog
// warns). The "פרטי הזמנה" card that lived here until 20/11/2026 is now the
// window's "פירוט עסקה" (issue-sheet/OrderTransaction.tsx).

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, UserPen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { validatePhone } from '@/lib/validation';
import { CHIP_ORDER_ROLE_LABEL, type ChipOrderRole } from '@/lib/chipOrders/model';

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה');
  return data;
}

// ── "עדכן בכרטיס הדייר" ────────────────────────────────────────────────────

export function HolderRegistryButton({
  itemId, apartmentNumber, role, name, phone, canWriteContacts, disabled, onDone, onModalChange,
}: {
  /** The block's apartment line of the order — the server resolves the
   *  apartment from it. */
  itemId: string;
  apartmentNumber: string;
  /** The block's role — the registry slot written (20/11/2026: per block). */
  role: ChipOrderRole;
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
      await postJson(`/api/chip-orders/items/${itemId}/registry`, { name: n || null, phone: p || null, role });
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
      <button
        type="button"
        disabled={disabled || !ready}
        onClick={() => setModal(true)}
        data-testid="chip-holder-registry-update"
        className="ci-ghostbtn w-fit"
      >
        <UserPen className="h-4 w-4" />
        עדכן בכרטיס הדייר
      </button>
      {!canWriteContacts && (
        <span className="ci-meta">עדכון כרטיס הדייר דורש הרשאת עריכה ברשימת הדיירים.</span>
      )}
      {canWriteContacts && !phoneOk && (
        <span className="ci-err">⚠️ מספר הטלפון בבלוק לא תקין</span>
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
