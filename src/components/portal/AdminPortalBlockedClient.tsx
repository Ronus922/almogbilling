'use client';

// /admin/portal-blocked — the phones the portal blocks (lib/portal/identity.ts):
// a phone whose apartments carry different names sees no financial data until
// the names agree or someone approves that it is ONE person. Per phone:
//   • the classifier's suggestion (lib/portal/blockedClassify.ts) — a
//     suggestion, never a decision; "שמות ללא קשר" (a suspected typing
//     mistake) sorts first;
//   • "אדם אחד" — approve one identity (IdentityApprovalPanel); refused while
//     a link has no name, which is completed on the apartment card instead
//     ("השלם שם");
//   • "נתק" on every link;
//   • a waiting request from the apartment card ("אותו אדם?" without
//     portal_manage) — approved with "אדם אחד" or turned down.
// Below, the identities in force, each revocable. Every decision is logged.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { BadgeCheck, PhoneOff, UserCheck, XCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/notifications/registry';
import { BLOCKED_PHONE_CATEGORY_LABEL, type BlockedPhoneCategory } from '@/lib/portal/blockedClassify';
import { PORTAL_ROLE_LABEL } from '@/lib/portal/identity';
import { rosterPhoneDisplay, rosterSourceLabel } from '@/lib/portal/rosterLabels';
import {
  IDENTITY_RELATION_LABEL, type ApprovedPortalIdentity, type BlockedPortalPhone,
} from '@/lib/types/portal';
import { DetachLinkButton } from './DetachLinkButton';
import { IdentityApprovalPanel, type IdentityApprovalValue } from './IdentityApprovalPanel';

/** DESIGN §2 tones: the suspected mistake in rose, a missing name in amber,
 *  the likely-one-person kinds in calm tones. */
const CATEGORY_TONE: Record<BlockedPhoneCategory, string> = {
  unrelated: 'bg-rose-50 text-rose-700',
  missing_name: 'bg-amber-50 text-amber-700',
  family: 'bg-violet-50 text-violet-700',
  company_contact: 'bg-blue-50 text-blue-700',
  spelling: 'bg-emerald-50 text-emerald-700',
};

type EndTarget = { id: string; action: 'revoke' | 'reject'; label: string };

export function AdminPortalBlockedClient({ canEdit }: { canEdit: boolean }) {
  const [phones, setPhones] = useState<BlockedPortalPhone[] | null>(null);
  const [approved, setApproved] = useState<ApprovedPortalIdentity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<BlockedPortalPhone | null>(null);
  const [ending, setEnding] = useState<EndTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/portal-blocked', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { phones: BlockedPortalPhone[]; approved: ApprovedPortalIdentity[] };
      setPhones(data.phones);
      setApproved(data.approved);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(body: object, success: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/portal-identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(success);
      await load();
      return true;
    } catch (err) {
      toast.error(`הפעולה נכשלה: ${(err as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function approve(v: IdentityApprovalValue) {
    if (!approving) return;
    const ok = await post({ action: 'approve', phone_e164: approving.phone_e164, ...v }, 'הזהות אושרה — הטלפון פתוח בפורטל');
    if (ok) setApproving(null);
  }

  async function end() {
    if (!ending) return;
    const ok = await post(
      { action: ending.action, id: ending.id },
      ending.action === 'revoke' ? 'האישור בוטל — הטלפון חסום שוב' : 'הבקשה נדחתה',
    );
    if (ok) setEnding(null);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">טלפונים חסומים</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            טלפון שרשום בכמה דירות תחת שמות שונים לא רואה נתונים כספיים בפורטל. אם זה אדם אחד —
            אשרו &quot;אדם אחד&quot;; אם שיוך שגוי — נתקו אותו; רשומה בלי שם — השלימו את השם בכרטיס הדירה.
            הסיווג הוא הצעה בלבד.
          </p>
        </div>
        <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-2">
          <PhoneOff className="h-4 w-4 text-amber-600" aria-hidden />
          {phones ? `${phones.length} טלפונים` : '—'}
        </span>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          שגיאה בטעינת הרשימה: {error}
        </div>
      ) : !phones ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      ) : phones.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          אין טלפונים חסומים — כל טלפון בפורטל משויך לדירות של אדם אחד.
        </div>
      ) : (
        <ul className="space-y-3">
          {phones.map((p) => {
            const nameless = p.links.some((l) => !l.owner_name?.trim());
            return (
              <li key={p.phone_e164} data-blocked-phone={p.phone_e164} className="rounded-2xl border border-line bg-white p-4 shadow-soft-xs">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <span dir="ltr" className="font-num text-base font-bold tabular-nums text-slate-900">
                      {rosterPhoneDisplay(p.phone_e164)}
                    </span>
                    <span className="text-sm text-slate-500">{p.links.length} דירות</span>
                    <span
                      data-category={p.category}
                      className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', CATEGORY_TONE[p.category])}
                    >
                      {BLOCKED_PHONE_CATEGORY_LABEL[p.category]}
                    </span>
                    {p.pending && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                        ממתין לאישור &quot;אותו אדם&quot;{p.pending.requested_by_name ? ` · ${p.pending.requested_by_name}` : ''} · {formatRelativeTime(p.pending.requested_at)}
                      </span>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      {p.pending && (
                        <Button
                          type="button" variant="outline" className="h-11 gap-1.5 px-4" disabled={busy}
                          onClick={() => setEnding({ id: p.pending!.id, action: 'reject', label: rosterPhoneDisplay(p.phone_e164) })}
                        >
                          <XCircle className="h-4 w-4" aria-hidden />
                          דחה בקשה
                        </Button>
                      )}
                      <Button
                        type="button" className="h-11 gap-1.5 px-4" disabled={busy || nameless}
                        title={nameless ? 'לרשומה אין שם — השלימו אותו בכרטיס הדירה' : undefined}
                        onClick={() => setApproving(p)}
                      >
                        <UserCheck className="h-4 w-4" aria-hidden />
                        אדם אחד
                      </Button>
                    </div>
                  )}
                </div>
                <ul className="space-y-2">
                  {p.links.map((l) => (
                    <li
                      key={l.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">
                          דירה <span className="font-num">{l.apartment_number}</span>
                          <span className="font-normal text-slate-700"> · {l.owner_name ?? 'בלי שם'} · {PORTAL_ROLE_LABEL[l.role]}</span>
                        </p>
                        <p className="text-xs text-slate-500">
                          מקור: {rosterSourceLabel(l.source_table, l.role)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {!l.owner_name?.trim() && (
                          <Link
                            href={`/contacts?apt=${encodeURIComponent(l.apartment_number)}`}
                            className={buttonVariants({ variant: 'outline', className: 'h-11 px-4' })}
                          >
                            השלם שם
                          </Link>
                        )}
                        {canEdit && (
                          <DetachLinkButton
                            id={l.id}
                            apartmentNumber={l.apartment_number}
                            phoneE164={p.phone_e164}
                            ownerName={l.owner_name}
                            onDetached={() => void load()}
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {approved.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <BadgeCheck className="h-5 w-5 text-emerald-600" aria-hidden />
            זהויות מאושרות
          </h2>
          <ul className="space-y-3">
            {approved.map((a) => (
              <li key={a.id} data-approved-phone={a.phone_e164} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-4 shadow-soft-xs">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="text-base font-bold text-slate-900">{a.display_name}</span>
                    <span dir="ltr" className="font-num tabular-nums text-slate-600">{rosterPhoneDisplay(a.phone_e164)}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {a.apartments.map((x) => `דירה ${x.apartment_number} · ${IDENTITY_RELATION_LABEL[x.relation]}`).join(' | ')}
                  </p>
                  <p className="text-xs text-slate-500">
                    אושר{a.decided_by_name ? ` ע״י ${a.decided_by_name}` : ''} · {formatRelativeTime(a.decided_at)}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    type="button" variant="outline" className="h-11 px-4" disabled={busy}
                    onClick={() => setEnding({ id: a.id, action: 'revoke', label: a.display_name })}
                  >
                    בטל אישור
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {approving && (
        <IdentityApprovalPanel
          open
          phoneE164={approving.phone_e164}
          apartments={approving.links.map((l) => ({ apartment_number: l.apartment_number, name: l.owner_name, role: l.role }))}
          busy={busy}
          onOpenChange={(o) => { if (!o) setApproving(null); }}
          onSubmit={(v) => void approve(v)}
        />
      )}

      <AlertDialog open={!!ending} onOpenChange={(o) => { if (!o && !busy) setEnding(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ending?.action === 'revoke' ? `לבטל את האישור של ${ending.label}?` : `לדחות את הבקשה ל-${ending?.label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ending?.action === 'revoke'
                ? 'הטלפון ייחסם בפורטל מיד אם השמות בדירות שלו שונים. הפעולה נרשמת ביומן.'
                : 'הטלפון יישאר חסום. הפעולה נרשמת ביומן.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void end(); }}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {ending?.action === 'revoke' ? 'בטל אישור' : 'דחה'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
