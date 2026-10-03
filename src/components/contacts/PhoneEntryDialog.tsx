'use client';

// The entry warning of the apartment card (03/10/2026, "אזהרה בהזנה"): the
// save put a phone on this card that ANOTHER apartment already carries under
// ANOTHER name, and the server saved nothing (409 phone_conflict). One
// question per such phone, three answers and NO default:
//   • "כן, אותו אדם" — saved, and the identity is approved (with portal_manage:
//     the name and the relations are chosen in IdentityApprovalPanel first) or
//     requested (without it: it waits on "טלפונים חסומים", the phone stays
//     blocked);
//   • "לא, אדם אחר" — saved; the phone is blocked and flagged as a suspected
//     typing mistake;
//   • "ביטול" — back to editing, nothing saved.
// The answers go back with the same save (phone_decisions); the server logs
// each one with the user who gave it.
//
// Every screen that writes a resident phone asks through usePhoneEntryWarning
// below — the apartment card and the debtor panel — so there is one flow, not
// a copy per screen (server half: lib/http/phoneEntry.ts).

import { useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { IdentityApprovalPanel, type IdentityApprovalValue } from '@/components/portal/IdentityApprovalPanel';
import { rosterPhoneDisplay } from '@/lib/portal/rosterLabels';
import type { PhoneEntryConflict, PhoneEntryDecision } from '@/lib/types/portal';

/** "רונן משולם בדירה 1210" · "רשומה ללא שם בדירה 520" — every other apartment. */
function whereLabel(c: PhoneEntryConflict): string {
  return c.others.map((o) => `${o.name?.trim() || 'רשומה ללא שם'} בדירה ${o.apartment_number}`).join(', ');
}

export function PhoneEntryDialog({ conflicts, canApprove, busy, onAnswered, onCancel }: {
  /** null = closed. */
  conflicts: PhoneEntryConflict[] | null;
  canApprove: boolean;
  busy: boolean;
  /** Every conflict answered — resend the save with these. */
  onAnswered: (decisions: PhoneEntryDecision[]) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<PhoneEntryDecision[]>([]);
  const [approving, setApproving] = useState(false);
  const current = conflicts?.[index] ?? null;

  function reset() {
    setIndex(0);
    setAnswers([]);
    setApproving(false);
  }

  function answer(d: PhoneEntryDecision) {
    const next = [...answers, d];
    if (conflicts && index + 1 < conflicts.length) {
      setAnswers(next);
      setIndex(index + 1);
      setApproving(false);
      return;
    }
    reset();
    onAnswered(next);
  }

  function cancel() {
    reset();
    onCancel();
  }

  function same() {
    if (!current) return;
    if (canApprove) setApproving(true);
    else answer({ phone_e164: current.phone_e164, decision: 'same' });
  }

  function approved(v: IdentityApprovalValue) {
    if (!current) return;
    answer({ phone_e164: current.phone_e164, decision: 'same', identity: v });
  }

  return (
    <>
      <AlertDialog open={!!current && !approving} onOpenChange={(o) => { if (!o && !busy) cancel(); }}>
        <AlertDialogContent dir="rtl">
          {current && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  הטלפון הזה רשום אצל {whereLabel(current)}. אותו אדם?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <span dir="ltr" className="font-num">{rosterPhoneDisplay(current.phone_e164)}</span>
                  {' '}נשמר כאן תחת {current.entered_name?.trim() ? `"${current.entered_name.trim()}"` : 'רשומה ללא שם'}.
                  {' '}
                  {canApprove
                    ? '"כן" יאשר שזה אדם אחד — תתבקש לבחור שם תצוגה וקשר לכל דירה.'
                    : '"כן" ישלח בקשה לאישור — עד שיאושר במסך "טלפונים חסומים" הטלפון לא יראה נתונים בפורטל.'}
                  {' '}&quot;לא&quot; יחסום את הטלפון בפורטל ויסמן חשד לטעות הזנה.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="gap-2">
                <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
                <Button type="button" variant="outline" className="h-11 px-4" disabled={busy}
                  onClick={() => answer({ phone_e164: current.phone_e164, decision: 'different' })}>
                  לא, אדם אחר
                </Button>
                <Button type="button" className="h-11 px-4" disabled={busy} onClick={same}>
                  כן, אותו אדם
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {current && (
        <IdentityApprovalPanel
          open={approving}
          phoneE164={current.phone_e164}
          apartments={[
            { apartment_number: current.apartment_number, name: current.entered_name, role: current.role },
            ...current.others.map((o) => ({ apartment_number: o.apartment_number, name: o.name, role: o.role })),
          ]}
          busy={busy}
          onOpenChange={(o) => { if (!o) setApproving(false); }}
          onSubmit={approved}
        />
      )}
    </>
  );
}

/**
 * The entry warning for one screen. Hand every phone-write response to `ask`:
 * when it is the 409 phone_conflict, the dialog opens and `ask` answers true —
 * nothing was saved; once every phone is answered, `resend` runs with the
 * answers (send the SAME write again with them as phone_decisions). "ביטול"
 * just closes it, back to editing. Render `dialog` once; `open` lets the
 * screen hold its own Escape handling while the question is up.
 */
export function usePhoneEntryWarning(busy: boolean): {
  ask: (status: number, body: unknown, resend: (decisions: PhoneEntryDecision[]) => void) => boolean;
  open: boolean;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{
    conflicts: PhoneEntryConflict[];
    canApprove: boolean;
    resend: (decisions: PhoneEntryDecision[]) => void;
  } | null>(null);

  function ask(status: number, body: unknown, resend: (decisions: PhoneEntryDecision[]) => void): boolean {
    const b = (body ?? {}) as { error?: string; conflicts?: PhoneEntryConflict[]; can_approve?: boolean };
    if (status !== 409 || b.error !== 'phone_conflict' || !b.conflicts) return false;
    setPending({ conflicts: b.conflicts, canApprove: b.can_approve === true, resend });
    return true;
  }

  const dialog = (
    <PhoneEntryDialog
      conflicts={pending?.conflicts ?? null}
      canApprove={pending?.canApprove ?? false}
      busy={busy}
      onAnswered={(decisions) => {
        const resend = pending?.resend;
        setPending(null);
        resend?.(decisions);
      }}
      onCancel={() => setPending(null)}
    />
  );
  return { ask, open: pending !== null, dialog };
}
