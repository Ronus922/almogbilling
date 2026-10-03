'use client';

// Approving a NEW OWNER NAME from Bllink is one of two different decisions
// (03/10/2026), offered side by side with no default:
//   • "תיקון שם" — the same owner, spelled differently: the name only, no
//     phone detached;
//   • "החלפת בעלים" — a different person bought the apartment: the previous
//     owner's phones are detached from the portal. A confirmation dialog shows
//     exactly which (GET /api/contacts/suggestions/replacement — the same SQL
//     function the approval applies) and the new owner's phone approved with
//     it.
// Used by the Bllink panel and by the tags on the apartment card.

import { useState } from 'react';
import { toast } from 'sonner';
import { PenLine, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { rosterPhoneDisplay } from '@/lib/portal/rosterLabels';
import { toPortalE164 } from '@/lib/portal/phone';
import type { ContactSuggestion, OwnerReplacementPreview } from '@/lib/types/contactSuggestions';

export function OwnerNameDecision({ suggestion, busy, size = 'sm', onResolve }: {
  suggestion: ContactSuggestion;
  busy: boolean;
  size?: 'sm' | 'xs';
  onResolve: (action: 'approve_rename' | 'approve_replace') => void;
}) {
  const [preview, setPreview] = useState<OwnerReplacementPreview | null>(null);
  const [loading, setLoading] = useState(false);

  async function openReplace() {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/suggestions/replacement?id=${encodeURIComponent(suggestion.id)}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreview(((await res.json()) as { preview: OwnerReplacementPreview }).preview);
    } catch (e) {
      toast.error(`טעינת פרטי ההחלפה נכשלה: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  const cls = size === 'xs' ? 'h-9 gap-1 px-3 text-xs' : 'flex-1 gap-1.5 sm:flex-none';
  const newE164 = preview?.new_phone ? toPortalE164(preview.new_phone) : null;

  return (
    <>
      <Button
        type="button" variant="outline" size="sm" disabled={busy || loading}
        onClick={() => onResolve('approve_rename')}
        className={`${cls} border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700`}
      >
        <PenLine className="h-4 w-4" /> תיקון שם
      </Button>
      <Button
        type="button" variant="outline" size="sm" disabled={busy || loading}
        onClick={() => void openReplace()}
        className={`${cls} border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-700`}
      >
        <UserRoundCog className="h-4 w-4" /> החלפת בעלים
      </Button>

      <AlertDialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להחליף את הבעלים של דירה {preview?.apartment_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview?.from_name ?? 'ללא שם'} ← {preview?.to_name}. הפעולה נרשמת ביומן.
            </AlertDialogDescription>
            <div className="space-y-3 text-sm text-muted-foreground">
              {preview && preview.detach.length > 0 ? (
                <div>
                  <p className="font-semibold text-slate-900">ינותקו מהפורטל:</p>
                  <ul className="mt-1 space-y-1">
                    {preview.detach.map((d) => (
                      <li key={d.phone_e164}>
                        <span dir="ltr" className="font-num">{rosterPhoneDisplay(d.phone_e164)}</span>
                        {d.owner_name ? ` · ${d.owner_name}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>אין טלפון של הבעלים הקודם שפתוח בפורטל — לא ינותק דבר.</p>
              )}
              {preview?.new_phone && (
                <p>
                  יאושר גם הטלפון של הבעלים החדש:{' '}
                  <span dir="ltr" className="font-num">{newE164 ? rosterPhoneDisplay(newE164) : preview.new_phone}</span>
                </p>
              )}
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setPreview(null); onResolve('approve_replace'); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              החלף בעלים
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
