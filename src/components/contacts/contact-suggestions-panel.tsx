'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Check, Inbox, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { formatRelativeTime } from '@/lib/notifications/registry';
import { SUGGESTION_FIELD_LABEL, type ContactSuggestion } from '@/lib/types/contactSuggestions';

/**
 * The Bllink approval queue (29/09/2026).
 *
 * The sync stopped overwriting resident fields: a value that conflicts with
 * ours waits here. One row per apartment+field, ours on the right, Bllink's on
 * the left, and two buttons. Approving writes the value exactly as typing it
 * into the apartment card would — an approved owner phone reaches the portal
 * roster through the same trigger, so that owner can sign in at once.
 */
export function ContactSuggestionsPanel({ open, items, canEdit, onOpenChange, onChanged }: {
  open: boolean;
  /** The open queue, loaded by the caller when it opened the panel. null while
   *  that fetch is in flight — which is also what "show the skeleton" means. */
  items: ContactSuggestion[] | null;
  /** contacts:edit — false renders the queue read-only. */
  canEdit: boolean;
  onOpenChange: (o: boolean) => void;
  /** The queue after a decision. The caller owns the count on the button and
   *  reloads the table, because approving wrote into contacts. */
  onChanged: (items: ContactSuggestion[]) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const loading = items === null;

  async function resolve(ids: string[], action: 'approve' | 'reject') {
    setBusy(ids.length === 1 ? ids[0] : 'all');
    try {
      const res = await fetch('/api/contacts/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { resolved: number; items: ContactSuggestion[] };
      onChanged(data.items);
      toast.success(action === 'approve'
        ? `${data.resolved} הצעות אושרו ונכתבו לרשימת הדיירים`
        : `${data.resolved} הצעות נדחו`);
    } catch (e) {
      toast.error(`הפעולה נכשלה: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">הצעות מבלינק</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'הסנכרון לא דורס את רשימת הדיירים. כל ערך שונה ממתין כאן להחלטה — עד אז שלכם עומד.'
                    : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />)}
              </div>
            ) : items!.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white p-8 text-center">
                <Inbox className="h-8 w-8 text-slate-300" />
                <p className="text-sm font-semibold text-slate-900">אין הצעות פתוחות</p>
                <p className="text-sm text-muted-foreground">כשבלינק יציע ערך שונה ממה שרשום כאן — הוא יופיע ברשימה הזו.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items!.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    suggestion={s}
                    canEdit={canEdit}
                    busy={busy !== null}
                    onApprove={() => resolve([s.id], 'approve')}
                    onReject={() => resolve([s.id], 'reject')}
                  />
                ))}
              </div>
            )}
          </div>

          <PanelFooter
            onClose={() => onOpenChange(false)}
            onSave={() => setConfirmAll(true)}
            saveLabel="אשר הכל"
            saveDisabled={!canEdit || !items || items.length === 0 || busy !== null}
            saveDisabledReason={!canEdit ? 'אין הרשאה לעריכת רשימת דיירים' : undefined}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לאשר את כל ההצעות?</AlertDialogTitle>
            <AlertDialogDescription>
              {items?.length ?? 0} ערכים מבלינק ייכתבו לרשימת הדיירים במקום הערכים הנוכחיים. אפשר לערוך כל שדה ידנית אחר כך.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void resolve((items ?? []).map((s) => s.id), 'approve')}>
              אשר הכל
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SuggestionRow({ suggestion, canEdit, busy, onApprove, onReject }: {
  suggestion: ContactSuggestion;
  canEdit: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const numeric = suggestion.field !== 'owner_name';
  return (
    <div
      data-suggestion={`${suggestion.apartment_number}:${suggestion.field}`}
      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-semibold text-slate-900">דירה {suggestion.apartment_number}</span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            {SUGGESTION_FIELD_LABEL[suggestion.field]}
          </span>
          <span className="text-xs text-muted-foreground">{formatRelativeTime(suggestion.created_at)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
          <Value value={suggestion.current_value} numeric={numeric} muted />
          <ArrowLeft className="h-4 w-4 shrink-0 text-slate-400" aria-label="מוצע" />
          <Value value={suggestion.proposed_value} numeric={numeric} />
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center gap-2 sm:shrink-0">
          <Button
            type="button" variant="outline" size="sm" disabled={busy} onClick={onApprove}
            className="flex-1 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700 sm:flex-none"
          >
            <Check className="h-4 w-4" /> אשר
          </Button>
          <Button
            type="button" variant="outline" size="sm" disabled={busy} onClick={onReject}
            className="flex-1 gap-1.5 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 sm:flex-none"
          >
            <X className="h-4 w-4" /> דחה
          </Button>
        </div>
      )}
    </div>
  );
}

function Value({ value, numeric, muted = false }: { value: string | null; numeric: boolean; muted?: boolean }) {
  if (!value?.trim()) return <span className="text-muted-foreground">— ריק</span>;
  return (
    <span
      dir={numeric ? 'ltr' : undefined}
      className={muted
        ? `truncate text-muted-foreground line-through ${numeric ? 'tabular-nums' : ''}`
        : `truncate font-semibold text-slate-900 ${numeric ? 'tabular-nums' : ''}`}
    >
      {value}
    </span>
  );
}
