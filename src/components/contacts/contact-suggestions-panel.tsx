'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Check, Inbox, KeyRound, ListChecks, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { formatRelativeTime } from '@/lib/notifications/registry';
import {
  SUGGESTION_FIELD_IS_NUMERIC, SUGGESTION_FIELD_LABEL, UNLINK_REASON_LABEL, type ContactSuggestion,
} from '@/lib/types/contactSuggestions';
import { PORTAL_ROLE_LABEL } from '@/lib/portal/identity';
import { rosterPhoneDisplay } from '@/lib/portal/rosterLabels';
import { OwnerNameDecision } from './OwnerNameDecision';
import { usePhoneEntryWarning } from './PhoneEntryDialog';
import type { PhoneEntryDecision } from '@/lib/types/portal';

type ResolveAction = 'approve' | 'reject' | 'approve_rename' | 'approve_replace';

/** "אשר הכל" may take it: changes no portal access and needs no choice. */
function bulkApprovable(s: ContactSuggestion): boolean {
  return !s.access && !s.owner_change;
}

/**
 * The Bllink approval queue (29/09/2026; split by portal access 03/10/2026).
 *
 * The sync stopped overwriting resident fields: a value that conflicts with
 * ours — and EVERY phone, even for an empty field — waits here, with the
 * people Bllink lists that the portal does not have ("שיוך") and the linked
 * phones Bllink no longer lists ("ניתוק"). Two groups:
 *   • what changes portal access (a phone, a link, an unlink) — one by one;
 *   • the rest (names, addresses) — one by one or "אשר הכל", which never
 *     touches the first group.
 * A new owner name is "תיקון שם" or "החלפת בעלים" (OwnerNameDecision), never
 * a plain approve. Approving writes the value exactly as typing it into the
 * apartment card would; the portal roster follows at commit.
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
  // An approval writes to the apartment card — the card's "אותו אדם?" too.
  const phoneWarning = usePhoneEntryWarning(busy !== null);
  const loading = items === null;
  const accessItems = (items ?? []).filter((s) => s.access || s.owner_change);
  const otherItems = (items ?? []).filter(bulkApprovable);

  async function resolve(ids: string[], action: ResolveAction, phoneDecisions?: PhoneEntryDecision[]) {
    setBusy(ids.length === 1 ? ids[0] : 'all');
    try {
      const res = await fetch('/api/contacts/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, ids, ...(phoneDecisions ? { phone_decisions: phoneDecisions } : {}) }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (phoneWarning.ask(res.status, body, (d) => { void resolve(ids, action, d); })) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = body as { resolved: number; items: ContactSuggestion[] };
      onChanged(data.items);
      toast.success(action === 'reject'
        ? `${data.resolved} הצעות נדחו`
        : `${data.resolved} הצעות אושרו ונכתבו לרשימת הדיירים`);
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
              <div className="space-y-6">
                {accessItems.length > 0 && (
                  <SuggestionGroup
                    icon={<KeyRound className="h-4 w-4 text-amber-600" aria-hidden />}
                    title="משפיעות על הגישה לפורטל"
                    hint="טלפון, שיוך, ניתוק והחלפת בעלים — אישור אחד-אחד בלבד"
                  >
                    {accessItems.map((s) => (
                      <SuggestionRow key={s.id} suggestion={s} canEdit={canEdit} busy={busy !== null}
                        onResolve={(action) => resolve([s.id], action)} />
                    ))}
                  </SuggestionGroup>
                )}
                {otherItems.length > 0 && (
                  <SuggestionGroup
                    icon={<ListChecks className="h-4 w-4 text-slate-500" aria-hidden />}
                    title="שאר ההצעות"
                    hint="שמות ומיילים — אפשר לאשר אחת-אחת או בבת אחת (״אשר הכל״)"
                  >
                    {otherItems.map((s) => (
                      <SuggestionRow key={s.id} suggestion={s} canEdit={canEdit} busy={busy !== null}
                        onResolve={(action) => resolve([s.id], action)} />
                    ))}
                  </SuggestionGroup>
                )}
              </div>
            )}
          </div>

          <PanelFooter
            onClose={() => onOpenChange(false)}
            onSave={() => setConfirmAll(true)}
            saveLabel="אשר הכל"
            saveDisabled={!canEdit || otherItems.length === 0 || busy !== null}
            saveDisabledReason={!canEdit
              ? 'אין הרשאה לעריכת רשימת דיירים'
              : otherItems.length === 0 ? 'אין הצעות שאפשר לאשר בבת אחת — הצעות גישה מאושרות אחת-אחת' : undefined}
          />
        </SheetContent>
      </Sheet>

      {phoneWarning.dialog}

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לאשר את כל ההצעות שאינן משפיעות על גישה?</AlertDialogTitle>
            <AlertDialogDescription>
              {otherItems.length} ערכים מבלינק (שמות ומיילים) ייכתבו לרשימת הדיירים במקום הערכים הנוכחיים.
              הצעות טלפון, שיוך, ניתוק והחלפת בעלים לא ייכללו — הן מאושרות אחת-אחת. אפשר לערוך כל שדה ידנית אחר כך.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void resolve(otherItems.map((s) => s.id), 'approve')}>
              אשר הכל
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SuggestionGroup({ icon, title, hint, children }: {
  icon: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-900">{icon}{title}</h3>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** "שיוך" / "ניתוק" — the person: name · phone · role. */
function PersonLine({ s }: { s: ContactSuggestion }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold text-slate-900">{s.person_name ?? 'ללא שם'}</span>
      {s.phone_e164 && <span dir="ltr" className="font-num tabular-nums text-slate-700">{rosterPhoneDisplay(s.phone_e164)}</span>}
      {s.person_role && (
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          {PORTAL_ROLE_LABEL[s.person_role]}
        </span>
      )}
    </div>
  );
}

function SuggestionRow({ suggestion, canEdit, busy, onResolve }: {
  suggestion: ContactSuggestion;
  canEdit: boolean;
  busy: boolean;
  onResolve: (action: ResolveAction) => void;
}) {
  const numeric = SUGGESTION_FIELD_IS_NUMERIC[suggestion.field];
  const person = suggestion.field === 'portal_link' || suggestion.field === 'portal_unlink';
  const approveLabel = suggestion.field === 'portal_link' ? 'שייך' : suggestion.field === 'portal_unlink' ? 'נתק' : 'אשר';
  return (
    <div
      data-suggestion={`${suggestion.apartment_number}:${suggestion.field}${suggestion.phone_e164 ? `:${suggestion.phone_e164}` : ''}`}
      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-semibold text-slate-900">דירה {suggestion.apartment_number}</span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            {suggestion.owner_change ? 'שם בעלים חדש' : SUGGESTION_FIELD_LABEL[suggestion.field]}
          </span>
          <span className="text-xs text-muted-foreground">{formatRelativeTime(suggestion.created_at)}</span>
        </div>
        {person ? (
          <PersonLine s={suggestion} />
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <Value value={suggestion.current_value} numeric={numeric} muted />
            <ArrowLeft className="h-4 w-4 shrink-0 text-slate-400" aria-label="מוצע" />
            <Value value={suggestion.proposed_value} numeric={numeric} />
          </div>
        )}
        {suggestion.field === 'portal_unlink' && suggestion.unlink_reason && (
          <p className="mt-1.5 text-xs text-slate-600">למה: {UNLINK_REASON_LABEL[suggestion.unlink_reason]}</p>
        )}
        {suggestion.marks_rented && (
          <p className="mt-1.5 text-xs text-amber-700">אישור יסמן בכרטיס הדירה סוג דייר &quot;שוכר&quot;.</p>
        )}
        {suggestion.waits_for_owner_name && (
          <p className="mt-1.5 text-xs text-amber-700">ממתין להחלטה על שם הבעלים של הדירה (תיקון שם / החלפת בעלים).</p>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {suggestion.owner_change ? (
            <OwnerNameDecision suggestion={suggestion} busy={busy} onResolve={onResolve} />
          ) : (
            <Button
              type="button" variant="outline" size="sm" disabled={busy || suggestion.waits_for_owner_name}
              onClick={() => onResolve('approve')}
              className="flex-1 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700 sm:flex-none"
            >
              <Check className="h-4 w-4" /> {approveLabel}
            </Button>
          )}
          <Button
            type="button" variant="outline" size="sm" disabled={busy} onClick={() => onResolve('reject')}
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
