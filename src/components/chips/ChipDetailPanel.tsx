'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  X, KeyRound, User, CreditCard, Cpu, StickyNote, Pencil, Info, History,
  Ban, Power, ArrowLeftRight, Copy, AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SupplierSection } from '@/components/suppliers/SupplierSection';
import { SupplierField, ReadonlyField, FIELD_LABEL } from '@/components/suppliers/SupplierField';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import { formatPhoneDisplay } from '@/lib/phone';
import {
  CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL, DEACTIVATION_REASON_LABEL,
  CHIP_EVENT_LABEL, CHIP_RESIDENT_ROLES, APP_PLATFORMS, APP_PLATFORM_LABEL,
} from '@/lib/constants/chips';
import type {
  Chip, ChipEvent, ChipEventType, ChipStatus, ChipResidentRole,
  ChipDeactivationReason, AppPlatform,
} from '@/lib/types/chips';

// Sentinel for "no role" — base-ui Select needs a non-empty value.
const NONE = '__none__';

// DESIGN.md §28.9 status pill — active green, inactive rose.
const STATUS_PILL: Record<ChipStatus, { label: string; cls: string; dot: string }> = {
  active: { label: 'פעיל', cls: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  inactive: { label: 'מושבת', cls: 'bg-rose-100 text-rose-700', dot: 'bg-rose-500' },
};

interface Props {
  chipId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canEdit: boolean;
  onChanged: () => void;
  onRequestDeactivate: (chip: Chip) => void;
  onRequestReactivate: (chip: Chip) => void;
  onRequestReissue: (chip: Chip) => void;
}

// Editable subset ONLY — chip_number/status/contact_id are never editable here.
interface FormState {
  holder_name: string;
  holder_phone: string;
  resident_role: ChipResidentRole | null;
  app_platform: AppPlatform | null;
  issuance_fee: string;
  fee_charged: boolean;
  notes: string;
}

function toForm(c: Chip): FormState {
  return {
    holder_name: c.holder_name ?? '',
    holder_phone: c.holder_phone ?? '',
    resident_role: c.resident_role,
    app_platform: c.app_platform,
    issuance_fee: c.issuance_fee != null ? String(c.issuance_fee) : '',
    fee_charged: c.fee_charged,
    notes: c.notes ?? '',
  };
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatFee(value: number | null): string | null {
  if (value == null) return null;
  return `₪${value.toLocaleString('he-IL')}`;
}

export function ChipDetailPanel({
  chipId, open, onOpenChange, canEdit, onChanged,
  onRequestDeactivate, onRequestReactivate, onRequestReissue,
}: Props) {
  const router = useRouter();
  const [chip, setChip] = useState<Chip | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // Bumped after any mutation so the history tab refetches its events.
  const [eventsVersion, setEventsVersion] = useState(0);
  function bumpEvents() {
    setEventsVersion((v) => v + 1);
  }

  // Fetch chip on open.
  useEffect(() => {
    if (!open || !chipId) {
      setChip(null);
      setError(null);
      setEditing(false);
      setForm(null);
      setTouched({});
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setEditing(false); setForm(null); setTouched({});
    fetch(`/api/chips/${chipId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { chip: Chip }) => { if (!cancelled) setChip(data.chip); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, chipId]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function markTouched(key: keyof FormState) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form) return e;
    if (form.holder_phone.trim() && !validatePhone(form.holder_phone).valid) {
      e.holder_phone = validatePhone(form.holder_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.issuance_fee.trim()) {
      const n = Number(form.issuance_fee);
      if (!Number.isFinite(n) || n < 0) e.issuance_fee = 'סכום לא תקין';
    }
    return e;
  }, [form]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  const canSaveEdit = !!form && !errors.holder_phone && !errors.issuance_fee && !saving;

  const isDirty = editing; // edit mode is the only unsaved-state surface

  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (saving) return;
    if (isDirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    setEditing(false);
    setForm(null);
    onOpenChange(false);
  }

  function startEdit() {
    if (!chip) return;
    setForm(toForm(chip));
    setTouched({});
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setForm(null);
    setTouched({});
  }

  // Optimistic PATCH — apply locally, rollback on failure (edit mode restored
  // with the form intact so nothing typed is lost).
  async function handleSaveEdit() {
    if (!form || !chip || !chipId) return;
    if (!canSaveEdit) {
      setTouched({ holder_phone: true, issuance_fee: true });
      return;
    }
    const payload = {
      holder_name: form.holder_name.trim() || null,
      holder_phone: form.holder_phone.trim() ? validatePhone(form.holder_phone).normalized : null,
      resident_role: form.resident_role,
      app_platform: form.app_platform,
      issuance_fee: form.issuance_fee.trim() ? Number(form.issuance_fee) : null,
      fee_charged: form.fee_charged,
      notes: form.notes.trim() || null,
    };
    const prev = chip;
    setSaving(true);
    setChip({ ...prev, ...payload });
    setEditing(false);
    try {
      const r = await fetch(`/api/chips/${chipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await r.json().catch(() => ({}))) as { chip?: Chip; error?: string };
      if (!r.ok || !data.chip) throw new Error(data.error ?? 'שמירה נכשלה');
      setChip(data.chip);
      setForm(null);
      setTouched({});
      toast.success('הצ׳יפ עודכן');
      bumpEvents();
      onChanged();
      router.refresh();
    } catch (e) {
      setChip(prev); // rollback
      setEditing(true);
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleControllerSync() {
    if (!chipId || syncing) return;
    setSyncing(true);
    try {
      const r = await fetch(`/api/chips/${chipId}/controller-sync`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = (await r.json().catch(() => ({}))) as { chip?: Chip; error?: string };
      if (!r.ok || !data.chip) throw new Error(data.error ?? 'העדכון נכשל');
      setChip(data.chip);
      toast.success('עודכן');
      bumpEvents();
      onChanged();
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const pill = chip ? STATUS_PILL[chip.status] : null;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header — DETAIL family (navy diagonal gradient, DESIGN.md §28.2) */}
          <SheetHeader className="flex-none gap-2 bg-[linear-gradient(120deg,#0e1f4d_0%,#16308a_55%,#1d4ed8_100%)] px-8 py-5 text-white">
            {loading ? (
              <div className="space-y-2">
                <div className="h-8 w-56 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-72 rounded bg-white/10 animate-pulse" />
              </div>
            ) : chip && pill ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <SheetTitle dir="ltr" className="text-[26px] font-extrabold tabular-nums text-white">
                      {chip.chip_number}
                    </SheetTitle>
                    <span className={cn(
                      'inline-flex items-center gap-[5px] rounded-full px-[11px] py-[4px] text-xs font-semibold',
                      pill.cls,
                    )}>
                      <span className={cn('h-[6px] w-[6px] rounded-full', pill.dot)} />
                      {pill.label}
                    </span>
                  </div>
                  <p className="mt-[6px] inline-flex flex-wrap items-center gap-[7px] text-[13.5px] font-medium text-[#c7dbff]/80">
                    <KeyRound className="h-[15px] w-[15px]" />
                    דירה {chip.apartment_number}
                    {chip.resident_role && <> · {RESIDENT_ROLE_LABEL[chip.resident_role]}</>}
                    {chip.holder_name && <> · {chip.holder_name}</>}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="סגור"
                  className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[13px] bg-white/[0.14] text-white transition-colors hover:bg-white/[0.26]"
                >
                  <X className="h-5 w-5" strokeWidth={2.2} />
                </button>
              </div>
            ) : null}
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-[#f4f6fb] p-6">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                שגיאה בטעינת הפרטים: {error}
              </div>
            ) : loading || !chip ? (
              <div className="space-y-4">
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
              </div>
            ) : (
              <Tabs defaultValue="details" className="w-full">
                {/* DESIGN.md §28.3 in-sheet tab-bar — white card + blue active pill. */}
                <TabsList className="grid w-full grid-cols-2 gap-[8px] rounded-[14px] border border-[#e9edf4] bg-white p-[6px] group-data-horizontal/tabs:h-auto">
                  {[
                    { value: 'details', icon: Info, label: 'פרטים' },
                    { value: 'history', icon: History, label: 'היסטוריה' },
                  ].map(({ value, icon: TabIcon, label }) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className="h-[42px] gap-2 rounded-[10px] text-[14.5px] font-semibold text-[#64748b] data-active:bg-[#2563eb] data-active:font-bold data-active:text-white group-data-[variant=default]/tabs-list:data-active:shadow-none"
                    >
                      <TabIcon className="h-4 w-4" /> {label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {/* TAB — פרטים */}
                <TabsContent value="details" className="mt-5 space-y-4">
                  {editing && form ? (
                    <EditForm
                      chip={chip}
                      form={form}
                      set={set}
                      markTouched={markTouched}
                      errFor={errFor}
                      disabled={saving}
                    />
                  ) : (
                    <ViewDetails
                      chip={chip}
                      canEdit={canEdit}
                      syncing={syncing}
                      onControllerSync={handleControllerSync}
                    />
                  )}
                </TabsContent>

                {/* TAB — היסטוריה */}
                <TabsContent value="history" className="mt-5">
                  <ChipHistory chipId={chip.id} refreshSignal={eventsVersion} />
                </TabsContent>
              </Tabs>
            )}
          </div>

          {/* Footer — view mode actions (by status). NO delete button — product law. */}
          {!loading && chip && !editing && canEdit && (
            <footer className="flex-none flex items-center justify-between gap-3 border-t border-[#e7ebf1] bg-white px-8 py-[14px]">
              {/* right (RTL start): status actions */}
              <div className="flex items-center gap-[10px]">
                {chip.status === 'active' && (
                  <button
                    type="button"
                    onClick={() => onRequestDeactivate(chip)}
                    disabled={saving}
                    className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#fecaca] bg-white px-[18px] text-[14px] font-semibold text-[#dc2626] transition-colors hover:border-[#fca5a5] hover:bg-[#fef2f2] disabled:opacity-50"
                  >
                    <Ban className="h-4 w-4" />
                    השבת
                  </button>
                )}
                {chip.status === 'inactive' && (
                  <>
                    <button
                      type="button"
                      onClick={() => onRequestReactivate(chip)}
                      disabled={saving}
                      className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#bbf7d0] bg-white px-[18px] text-[14px] font-semibold text-[#15803d] transition-colors hover:border-[#86efac] hover:bg-[#f0fdf4] disabled:opacity-50"
                    >
                      <Power className="h-4 w-4" />
                      החזר לפעילות
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestReissue(chip)}
                      disabled={saving}
                      className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#bfdbfe] bg-white px-[18px] text-[14px] font-semibold text-[#2563eb] transition-colors hover:border-[#93c5fd] hover:bg-[#eff6ff] disabled:opacity-50"
                    >
                      <Copy className="h-4 w-4" />
                      הנפק חלופי
                    </button>
                  </>
                )}
              </div>
              {/* left (RTL end): edit (gradient primary) */}
              <button
                type="button"
                onClick={startEdit}
                disabled={saving}
                className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-[24px] text-[14px] font-bold text-white shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)] transition-colors hover:from-[#1e40af] hover:to-[#1d4ed8] disabled:opacity-50"
              >
                <Pencil className="h-4 w-4" />
                ערוך
              </button>
            </footer>
          )}

          {/* Footer — edit mode */}
          {!loading && chip && editing && (
            <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
                  ביטול
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={!canSaveEdit}
                  className="gap-2 bg-gradient-to-l from-blue-700 to-blue-600 text-white hover:from-blue-800 hover:to-blue-700 shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)]"
                >
                  {saving ? 'שומר…' : 'שמור שינויים'}
                </Button>
              </div>
            </footer>
          )}
        </SheetContent>
      </Sheet>

      {/* Confirm exit with unsaved changes */}
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
    </>
  );
}

/* ---------- View mode ---------- */

function ViewDetails({
  chip, canEdit, syncing, onControllerSync,
}: {
  chip: Chip;
  canEdit: boolean;
  syncing: boolean;
  onControllerSync: () => void;
}) {
  const pendingController = chip.status === 'inactive' && !chip.controller_synced;
  return (
    <>
      {/* פרטי צ׳יפ */}
      <SupplierSection title="פרטי צ׳יפ" icon={KeyRound} iconTone="blue">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="מספר צ׳יפ" value={chip.chip_number} ltr />
          <ReadonlyField label="סוג" value={CHIP_TYPE_LABEL[chip.chip_type]} />
          <ReadonlyField label="דירה" value={chip.apartment_number} />
          {chip.chip_type === 'app' && (
            <ReadonlyField
              label="פלטפורמה"
              value={chip.app_platform ? APP_PLATFORM_LABEL[chip.app_platform] : null}
            />
          )}
        </div>
      </SupplierSection>

      {/* מחזיק */}
      <SupplierSection title="מחזיק" icon={User} iconTone="violet">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="שם המחזיק" value={chip.holder_name} />
          <ReadonlyField
            label="תפקיד"
            value={chip.resident_role ? RESIDENT_ROLE_LABEL[chip.resident_role] : null}
          />
          <ReadonlyField label="טלפון" value={formatPhoneDisplay(chip.holder_phone)} ltr />
        </div>
      </SupplierSection>

      {/* הנפקה ועמלה */}
      <SupplierSection title="הנפקה ועמלה" icon={CreditCard} iconTone="emerald">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="הונפק ע״י" value={chip.issued_by_name} />
          <ReadonlyField label="תאריך הנפקה" value={formatDate(chip.issued_at)} ltr />
          <ReadonlyField label="עמלת הנפקה" value={formatFee(chip.issuance_fee)} ltr />
          <ReadonlyField label="חיוב עמלה" value={chip.fee_charged ? 'חויב' : 'לא חויב'} />
          {chip.limit_override_reason && (
            <ReadonlyField
              label="סיבת חריגה"
              value={chip.limit_override_reason}
              className="sm:col-span-2"
            />
          )}
        </div>
      </SupplierSection>

      {/* מצב בקר */}
      <SupplierSection title="מצב בקר" icon={Cpu} iconTone="amber">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField
            label="סטטוס בקר"
            value={chip.controller_synced ? 'עודכן בבקר' : 'לא עודכן בבקר'}
          />
          <ReadonlyField
            label="תאריך עדכון בבקר"
            value={formatDateTime(chip.controller_synced_at)}
            ltr
          />
        </div>
        {pendingController && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              ממתין לחסימה בבקר
            </p>
            {canEdit && (
              <button
                type="button"
                onClick={onControllerSync}
                disabled={syncing}
                className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-amber-300 bg-white px-[18px] text-[14px] font-semibold text-amber-800 transition-colors hover:border-amber-400 hover:bg-amber-100 disabled:opacity-50"
              >
                <Cpu className="h-4 w-4" />
                {syncing ? 'מעדכן…' : 'סומן בבקר'}
              </button>
            )}
          </div>
        )}
      </SupplierSection>

      {/* הערות */}
      {chip.notes && (
        <SupplierSection title="הערות" icon={StickyNote} iconTone="slate">
          <p className="whitespace-pre-wrap py-2 text-sm text-slate-700">{chip.notes}</p>
        </SupplierSection>
      )}
    </>
  );
}

/* ---------- Edit mode ---------- */

interface EditFormProps {
  chip: Chip;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  markTouched: (key: keyof FormState) => void;
  errFor: (key: keyof FormState) => string | null;
  disabled: boolean;
}

function EditForm({ chip, form, set, markTouched, errFor, disabled }: EditFormProps) {
  return (
    <>
      {/* פרטי צ׳יפ — readonly ALWAYS (chip_number never editable) */}
      <SupplierSection title="פרטי צ׳יפ" icon={KeyRound} iconTone="blue">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="מספר צ׳יפ" value={chip.chip_number} ltr />
          <ReadonlyField label="סוג" value={CHIP_TYPE_LABEL[chip.chip_type]} />
          <ReadonlyField label="דירה" value={chip.apartment_number} />
        </div>
      </SupplierSection>

      {/* מחזיק */}
      <SupplierSection title="מחזיק" icon={User} iconTone="violet">
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
          <SupplierField
            id="chip-holder-name" label="שם המחזיק"
            value={form.holder_name} onChange={(v) => set('holder_name', v)}
            disabled={disabled}
          />
          <SupplierField
            id="chip-holder-phone" label="טלפון"
            value={form.holder_phone} onChange={(v) => set('holder_phone', v)}
            onBlur={() => markTouched('holder_phone')} error={errFor('holder_phone')}
            disabled={disabled}
            inputMode="tel" dir="ltr" tabularNums placeholder="052-1234567"
          />
          <div className="space-y-1.5">
            <Label className={FIELD_LABEL}>תפקיד</Label>
            <Select
              value={form.resident_role ?? NONE}
              onValueChange={(v) => set('resident_role', !v || v === NONE ? null : (v as ChipResidentRole))}
              disabled={disabled}
            >
              <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
                <SelectValue placeholder="בחר תפקיד...">
                  {(value: string | null) => {
                    if (!value || value === NONE) return 'ללא תפקיד';
                    return RESIDENT_ROLE_LABEL[value as ChipResidentRole] ?? value;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>ללא תפקיד</SelectItem>
                {CHIP_RESIDENT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{RESIDENT_ROLE_LABEL[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {chip.chip_type === 'app' && (
            <div className="space-y-1.5">
              <Label className={FIELD_LABEL}>פלטפורמה</Label>
              <Select
                value={form.app_platform ?? NONE}
                onValueChange={(v) => set('app_platform', !v || v === NONE ? null : (v as AppPlatform))}
                disabled={disabled}
              >
                <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
                  <SelectValue placeholder="בחר פלטפורמה...">
                    {(value: string | null) => {
                      if (!value || value === NONE) return 'לא צוין';
                      return APP_PLATFORM_LABEL[value as AppPlatform] ?? value;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>לא צוין</SelectItem>
                  {APP_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>{APP_PLATFORM_LABEL[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </SupplierSection>

      {/* הנפקה ועמלה */}
      <SupplierSection title="הנפקה ועמלה" icon={CreditCard} iconTone="emerald">
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
          <ReadonlyField label="הונפק ע״י" value={chip.issued_by_name} />
          <ReadonlyField label="תאריך הנפקה" value={formatDate(chip.issued_at)} ltr />
          <SupplierField
            id="chip-issuance-fee" label="עמלת הנפקה (₪)"
            value={form.issuance_fee} onChange={(v) => set('issuance_fee', v)}
            onBlur={() => markTouched('issuance_fee')} error={errFor('issuance_fee')}
            disabled={disabled}
            inputMode="decimal" dir="ltr" tabularNums placeholder="0"
          />
          <div className="space-y-1.5">
            <Label className={FIELD_LABEL}>חיוב עמלה</Label>
            <Select
              value={form.fee_charged ? 'yes' : 'no'}
              onValueChange={(v) => { if (v) set('fee_charged', v === 'yes'); }}
              disabled={disabled}
            >
              <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
                <SelectValue placeholder="בחר...">
                  {(value: string | null) => (value === 'yes' ? 'חויב' : 'לא חויב')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">חויב</SelectItem>
                <SelectItem value="no">לא חויב</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SupplierSection>

      {/* הערות */}
      <SupplierSection title="הערות" icon={StickyNote} iconTone="slate">
        <div className="space-y-1.5">
          <Label htmlFor="chip-notes" className={FIELD_LABEL}>הערות</Label>
          <Textarea
            id="chip-notes"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            disabled={disabled}
            className="min-h-[74px] rounded-[10px] border-[#e2e8f0] px-[13px] py-[11px] text-[14px]"
          />
        </div>
      </SupplierSection>
    </>
  );
}

/* ---------- History tab (chip_events timeline, DESIGN.md §28.4) ---------- */

const EVENT_META: Record<ChipEventType, { icon: LucideIcon; tone: string }> = {
  issued: { icon: KeyRound, tone: 'bg-[#e7f7ee] text-[#16a34a]' },
  deactivated: { icon: Ban, tone: 'bg-[#ffe4e6] text-[#e11d48]' },
  reactivated: { icon: Power, tone: 'bg-[#e8f0ff] text-[#2563eb]' },
  reassigned: { icon: ArrowLeftRight, tone: 'bg-[#eef2ff] text-[#4f46e5]' },
  note: { icon: Pencil, tone: 'bg-[#eef2f7] text-[#475569]' },
  controller_synced: { icon: Cpu, tone: 'bg-[#fff3e6] text-[#ea8a18]' },
};

/** reason may be a deactivation-enum value or free text — map when possible. */
function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return DEACTIVATION_REASON_LABEL[reason as ChipDeactivationReason] ?? reason;
}

function ChipHistory({ chipId, refreshSignal }: { chipId: string; refreshSignal: number }) {
  const [events, setEvents] = useState<ChipEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/chips/${chipId}/events`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { items?: ChipEvent[] }) => { if (!cancelled) setEvents(data.items ?? []); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [chipId, refreshSignal]);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-16 rounded-xl bg-muted/60 animate-pulse" />
        <div className="h-16 rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        טעינת ההיסטוריה נכשלה: {error}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-[14px] border border-[#e9edf4] bg-white p-12 text-center">
        <History className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm text-muted-foreground">אין עדיין אירועים מתועדים</p>
      </div>
    );
  }

  return (
    <div>
      {/* section heading (violet icon + title + count) */}
      <div className="mb-5 flex items-center gap-[11px]">
        <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[#eef2ff] text-[#4f46e5]">
          <History className="h-[17px] w-[17px]" />
        </span>
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">היסטוריית הצ׳יפ</h2>
          <p className="text-[13px] font-medium text-[#94a3b8]">{events.length} אירועים</p>
        </div>
      </div>

      <ol className="relative">
        {/* rail on the logical-start edge */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-[10px] bottom-[30px] right-[21px] w-0.5 bg-[linear-gradient(#dbe2ec,#eef1f6)]"
        />
        {events.map((event) => {
          const meta = EVENT_META[event.event_type] ?? EVENT_META.note;
          const Icon = meta.icon;
          const reason = reasonLabel(event.reason);
          return (
            <li key={event.id} className="relative flex items-stretch gap-[18px] pb-[14px] last:pb-0">
              <div className="z-[1] flex w-11 shrink-0 justify-center">
                <span
                  className={cn(
                    'grid h-11 w-11 place-items-center rounded-[13px] border-[3px] border-[#f4f6fb]',
                    meta.tone,
                  )}
                >
                  <Icon className="h-[19px] w-[19px]" />
                </span>
              </div>
              <div className="flex flex-1 items-start justify-between gap-4 rounded-[14px] border border-[#e9edf4] bg-white px-[18px] py-[15px] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <div className="min-w-0 text-right">
                  <h3 className="text-[15.5px] font-bold text-[#0f172a]">
                    {CHIP_EVENT_LABEL[event.event_type] ?? event.event_type}
                  </h3>
                  {reason && (
                    <p className="mt-[5px] truncate text-[13.5px] font-medium text-[#475569]" title={reason}>
                      {reason}
                    </p>
                  )}
                  <p className="mt-[7px] flex items-center gap-[5px] text-[12.5px] font-medium text-[#94a3b8]">
                    <User className="h-[13px] w-[13px] text-[#cbd5e1]" />
                    {event.actor_name ?? 'מערכת'}
                  </p>
                </div>
                <span dir="ltr" className="shrink-0 whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[#94a3b8]">
                  {formatDateTime(event.created_at)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
