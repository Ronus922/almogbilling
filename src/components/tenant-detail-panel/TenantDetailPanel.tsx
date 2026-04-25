'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Info, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatPhoneDisplay, getPrimaryPhone, phoneTelHref } from '@/lib/phone';
import type {
  Tenant, TenantDetailResponse, TenantNote, PhonesUpdate, NextActionUpdate,
  LegalStatus, LegalStatusId, CompletedAction,
} from '@/types/tenant';
import { StatusBadge } from './StatusBadge';
import { MainDetailsCard } from './MainDetailsCard';
import { AdditionalInfoCard } from './AdditionalInfoCard';
import { QuickActionsCard } from './QuickActionsCard';
import { DebtsCard } from './DebtsCard';
import { NextActionCard, type NextActionDraft } from './NextActionCard';
import { LegalManagementCard } from './LegalManagementCard';
import { CommentsSection } from './CommentsSection';
import { CompletedActionsCard } from './CompletedActionsCard';
import { PanelFooter } from './PanelFooter';
import { PanelTabs, type PanelTabKey } from './PanelTabs';
import { EditPhoneDialog, type PhoneField } from './EditPhoneDialog';

interface Props {
  open: boolean;
  debtorId: string | null;
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
}

function dateToIsoStr(raw: string | null): string {
  if (!raw) return '';
  return String(raw).slice(0, 10);
}

export function TenantDetailPanel({ open, debtorId, isAdmin, onOpenChange }: Props) {
  const router = useRouter();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [statuses, setStatuses] = useState<LegalStatus[]>([]);
  const [notes, setNotes] = useState<TenantNote[]>([]);
  const [completedActions, setCompletedActions] = useState<CompletedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editField, setEditField] = useState<PhoneField | null>(null);
  const [nextActionDraft, setNextActionDraft] = useState<NextActionDraft>({ description: '', date: '' });
  const [saving, setSaving] = useState(false);
  // Sticky flag: any auto-saved mutation (status / phones / comment) flips this on
  // so "שמור שינויים" becomes a "Done" button the user can click to close.
  const [hasMutated, setHasMutated] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTabKey>('details');

  useEffect(() => {
    if (!open || !debtorId) {
      setTenant(null);
      setNotes([]);
      setCompletedActions([]);
      setError(null);
      setHasMutated(false);
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setTenant(null); setNotes([]); setCompletedActions([]); setHasMutated(false);
    Promise.all([
      fetch(`/api/debtors/${debtorId}`, { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`tenant HTTP ${r.status}`))),
      fetch('/api/statuses', { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`statuses HTTP ${r.status}`))),
      fetch(`/api/debtors/${debtorId}/comments`, { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`comments HTTP ${r.status}`))),
      fetch(`/api/debtors/${debtorId}/completed-actions`, { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`completed-actions HTTP ${r.status}`))),
    ])
      .then(([detail, stats, cs, cas]: [TenantDetailResponse, LegalStatus[], TenantNote[], CompletedAction[]]) => {
        if (cancelled) return;
        setTenant(detail.tenant);
        setStatuses(stats);
        setNotes(cs);
        setCompletedActions(cas);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, debtorId]);

  useEffect(() => {
    if (!tenant) return;
    setNextActionDraft({
      description: tenant.next_action_description ?? '',
      date: dateToIsoStr(tenant.next_action_date),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  const nextActionDirty = useMemo(() => {
    if (!tenant) return false;
    const current = {
      description: tenant.next_action_description ?? '',
      date: dateToIsoStr(tenant.next_action_date),
    };
    return nextActionDraft.description !== current.description
      || nextActionDraft.date !== current.date;
  }, [tenant, nextActionDraft]);

  const isDirty = hasMutated || nextActionDirty;

  // Close request — intercepts X / overlay / ESC / footer "סגור".
  // If anything was touched, show a confirm dialog before discarding.
  function requestClose() {
    if (isDirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSavePhone(field: PhoneField, value: string | null) {
    if (!debtorId) throw new Error('no_debtor');
    const patch: PhonesUpdate = { [field]: value };
    const res = await fetch(`/api/debtors/${debtorId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const j = await res.json() as { tenant: Tenant };
    setTenant(j.tenant);
    setHasMutated(true);
    toast.success('הטלפון עודכן');
    router.refresh();
  }

  async function handleSaveLegalStatus(id: LegalStatusId) {
    if (!debtorId || !tenant) return;
    const previous = tenant;
    const nextStatus = statuses.find((s) => s.id === id);
    if (!nextStatus) return;

    setTenant({
      ...tenant,
      legal_status_id: id,
      legal_status_name: nextStatus.name,
      legal_status_color: nextStatus.color,
      legal_status_is_default: nextStatus.is_default,
    });

    try {
      const res = await fetch(`/api/debtors/${debtorId}/legal-status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status_id: id }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = await res.json() as { tenant: Tenant };
      setTenant(j.tenant);
      setHasMutated(true);
      toast.success('הסטטוס עודכן');
      router.refresh();
    } catch (err) {
      setTenant(previous);
      const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
      toast.error(`שמירת הסטטוס נכשלה: ${msg}`);
    }
  }

  async function handleAddComment(content: string) {
    if (!debtorId) throw new Error('no_debtor');
    const res = await fetch(`/api/debtors/${debtorId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const note = await res.json() as TenantNote;
    setNotes((prev) => [note, ...prev]);
    setHasMutated(true);
  }

  async function handleSaveChanges() {
    if (!debtorId || !tenant || !isDirty) return;
    setSaving(true);
    try {
      // Persist any next-action draft. Status / phones / comments are already saved.
      if (nextActionDirty) {
        const patch: NextActionUpdate = {
          next_action_description: nextActionDraft.description.trim() || null,
          next_action_date: nextActionDraft.date || null,
        };
        const res = await fetch(`/api/debtors/${debtorId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const j = await res.json() as { tenant: Tenant };
        setTenant(j.tenant);
        toast.success('הפעולה הבאה נשמרה');
        router.refresh();
      }
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'שגיאה';
      toast.error(`שמירה נכשלה: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  const isLoading = loading || (open && !tenant && !error);

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            {isLoading ? (
              <div className="space-y-2">
                <div className="h-8 w-56 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-72 rounded bg-white/10 animate-pulse" />
              </div>
            ) : tenant ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <SheetTitle className="text-2xl font-bold text-white">
                      פרטי דירה {tenant.apartment_number}
                    </SheetTitle>
                    {tenant.legal_status_name && (
                      <StatusBadge
                        name={tenant.legal_status_name}
                        color={tenant.legal_status_color ?? '#f3f4f6'}
                        showIcon={!tenant.legal_status_is_default}
                      />
                    )}
                  </div>
                  <p className="mt-1 text-sm text-white/70">
                    {tenant.owner_name ?? '—'}
                    {(() => {
                      const raw = getPrimaryPhone(tenant);
                      const display = formatPhoneDisplay(raw);
                      const href = phoneTelHref(raw);
                      if (!display) return null;
                      return (
                        <>
                          <span className="mx-2 text-white/40">•</span>
                          <a href={href ? `tel:${href}` : undefined} className="hover:underline" dir="ltr">
                            {display}
                          </a>
                        </>
                      );
                    })()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="סגור"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : null}
          </SheetHeader>

          {/* Tabs row */}
          {!isLoading && tenant && (
            <PanelTabs active={activeTab} onChange={setActiveTab} />
          )}

          {/* Scroll area */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                שגיאה בטעינת הפרטים: {error}
              </div>
            ) : isLoading || !tenant ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
                <div className="h-56 rounded-xl bg-muted/60 animate-pulse" />
              </div>
            ) : (
              <div className="space-y-4">
                {!isAdmin && (
                  <Alert className="border-amber-200 bg-amber-50 text-amber-900">
                    <Info className="h-4 w-4" />
                    <AlertTitle className="text-amber-900">אתה מחובר כצופה</AlertTitle>
                    <AlertDescription className="text-amber-800">
                      ללא הרשאות עריכה. כל השדות והפעולות מושבתים.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <MainDetailsCard
                    tenant={tenant}
                    isAdmin={isAdmin}
                    onEditPhone={(f) => setEditField(f)}
                  />
                  <AdditionalInfoCard tenant={tenant} />
                  <QuickActionsCard />
                </div>

                <DebtsCard tenant={tenant} />

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <NextActionCard
                    value={nextActionDraft}
                    onChange={setNextActionDraft}
                    disabled={!isAdmin}
                  />
                  <LegalManagementCard
                    tenant={tenant}
                    statuses={statuses}
                    disabled={!isAdmin}
                    onSaveLegalStatus={handleSaveLegalStatus}
                  />
                </div>

                <CompletedActionsCard actions={completedActions} />

                <CommentsSection
                  notes={notes}
                  isAdmin={isAdmin}
                  onAddComment={handleAddComment}
                />
              </div>
            )}
          </div>

          {/* Footer */}
          {!isLoading && tenant && (
            <PanelFooter
              isAdmin={isAdmin}
              isDirty={isDirty}
              isSaving={saving}
              onClose={requestClose}
              onSave={handleSaveChanges}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              ביצעת שינויים שלא נשמרו. אם תצא עכשיו, השינויים יאבדו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditPhoneDialog
        open={editField !== null}
        field={editField ?? 'phone_owner'}
        initialValue={editField === 'phone_tenant' ? tenant?.phone_tenant ?? null : tenant?.phone_owner ?? null}
        onOpenChange={(o) => { if (!o) setEditField(null); }}
        onSave={handleSavePhone}
      />
    </>
  );
}

function SkeletonCard() {
  return <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />;
}
