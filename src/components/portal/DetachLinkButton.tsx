'use client';

// "נתק" — the one write the portal roster screens have. Detaching takes a
// phone off ONE apartment in the portal; it stays off while the card still
// holds the phone in the same role, and comes back only through the card (the
// phone removed and typed in again, or moved to its right role). Confirmation
// via AlertDialog (DESIGN.md §12).

import { useState } from 'react';
import { toast } from 'sonner';
import { Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { rosterPhoneDisplay } from '@/lib/portal/rosterLabels';

export function DetachLinkButton({ id, apartmentNumber, phoneE164, ownerName, onDetached }: {
  id: string;
  apartmentNumber: string;
  phoneE164: string;
  ownerName: string | null;
  onDetached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function detach() {
    setBusy(true);
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/owner-phones`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id, is_active: false }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success('השיוך נותק');
      setOpen(false);
      onDetached();
    } catch (err) {
      toast.error(`הניתוק נכשל: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" className="h-11 gap-1.5 px-4" onClick={() => setOpen(true)}>
        <Unlink className="h-4 w-4" aria-hidden />
        נתק
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לנתק את הטלפון מדירה {apartmentNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              <span dir="ltr" className="font-num">{rosterPhoneDisplay(phoneE164)}</span>
              {ownerName ? ` (${ownerName})` : ''} לא יראה עוד את דירה {apartmentNumber} בפורטל.
              כל עוד הטלפון רשום בכרטיס הדירה באותו תפקיד הוא יישאר מנותק — כדי להחזיר אותו
              יש להסיר אותו מהכרטיס ולהזין אותו מחדש, או לתקן את התפקיד שלו. הפעולה נרשמת ביומן.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void detach(); }}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              נתק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
