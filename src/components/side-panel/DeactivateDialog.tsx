'use client';

import { useEffect, useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DEACTIVATION_REASON_MAX } from '@/lib/constants/parking';

// Confirmation for switching a parking spot / storage unit OFF — the only
// "removal" those tables have. A Dialog is correct here per DESIGN.md §12:
// this is a destructive confirmation, not an entity edit (those are Sheets).
//
// Lives under side-panel/ rather than with the parking screen: the tenant form
// is now its only caller, and the screen it was written for is gone.
//
// The reason is mandatory and the action stays disabled until it is typed. That
// is enforced in three places on purpose — here, in the route's validation, and
// in the DB CHECK — because the reason is the ONLY record of why an assignment
// ended: there is no events table to recover it from later.

interface Props {
  open: boolean;
  /** What is being switched off, already phrased: e.g. 'חניה 63' / 'מחסן M-4'. */
  subject: string;
  /** Where it is currently assigned, for the warning line. */
  assignedTo: string | null;
  submitting: boolean;
  /**
   * Pre-filled reason for callers that already know why (the contacts panel
   * removes a row and can say so). The user may overwrite it; it is a default,
   * not a lock. Omitted → the field opens empty, as the /parking screen wants.
   */
  defaultReason?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function DeactivateDialog({
  open, subject, assignedTo, submitting, defaultReason = '', onCancel, onConfirm,
}: Props) {
  const [reason, setReason] = useState(defaultReason);

  // Reset between openings — a reason typed for one spot must never be carried
  // into the next one's confirmation.
  useEffect(() => {
    if (open) setReason(defaultReason);
  }, [open, defaultReason]);

  const trimmed = reason.trim();
  const tooLong = trimmed.length > DEACTIVATION_REASON_MAX;
  const canConfirm = trimmed.length > 0 && !tooLong && !submitting;

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !submitting) onCancel(); }}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>לבטל את ההפעלה של {subject}?</AlertDialogTitle>
          <AlertDialogDescription>
            {assignedTo
              ? `${subject} מוצמדת כעת ל${assignedTo}. הרשומה לא נמחקת — היא תיוותר בהיסטוריה ותוסתר מהרשימה הפעילה.`
              : 'הרשומה לא נמחקת — היא תיוותר בהיסטוריה ותוסתר מהרשימה הפעילה.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="deactivate-reason" className="text-base font-medium text-muted-foreground">
            סיבה
            <span className="text-red-500"> *</span>
          </Label>
          <Textarea
            id="deactivate-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            autoFocus
            placeholder="למשל: נמכרה לדייר אחר / שוחררה לטובת הקצאה מחדש"
            className={tooLong ? 'border-red-400 bg-red-50 focus-visible:ring-red-200' : undefined}
          />
          {tooLong ? (
            <p className="text-[12px] font-semibold text-red-500 text-start">
              ⚠️ הסיבה ארוכה מדי (עד {DEACTIVATION_REASON_MAX} תווים)
            </p>
          ) : (
            <p className="text-[12px] text-slate-500 text-start">
              הסיבה נשמרת עם הרשומה ומוצגת ברשימת המבוטלות.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>ביטול</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); if (canConfirm) onConfirm(trimmed); }}
            disabled={!canConfirm}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {submitting ? 'מבטל…' : 'בטל הפעלה'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
