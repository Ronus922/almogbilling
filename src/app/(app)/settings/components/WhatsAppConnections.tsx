'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Smartphone, QrCode, Plus, Pencil, Trash2, LogOut, Loader2, CheckCircle2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InstanceState =
  | 'notAuthorized'
  | 'authorized'
  | 'blocked'
  | 'starting'
  | 'yellowCard'
  | 'sleepMode';

interface WhatsAppInstance {
  id: string;
  user_id: string;
  display_name: string;
  green_instance_id: string;
  api_url: string;
  state: InstanceState;
  state_checked_at: string | null;
  created_at: string;
  owner_name: string | null;
  owner_username: string | null;
}

interface UserOption {
  id: string;
  label: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: InstanceState }) {
  const config: Record<InstanceState, { label: string; cls: string }> = {
    authorized:    { label: 'מחובר',          cls: 'bg-emerald-100 text-emerald-700' },
    notAuthorized: { label: 'ממתין לחיבור',   cls: 'bg-amber-100 text-amber-700' },
    starting:      { label: 'ממתין לחיבור',   cls: 'bg-amber-100 text-amber-700' },
    blocked:       { label: 'חסום',            cls: 'bg-red-100 text-red-700' },
    yellowCard:    { label: 'אזהרה',           cls: 'bg-red-100 text-red-700' },
    sleepMode:     { label: 'במצב שינה',       cls: 'bg-slate-100 text-slate-600' },
  };
  const { label, cls } = config[state] ?? { label: state, cls: 'bg-slate-100 text-slate-600' };
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', cls)}>
      {label}
    </span>
  );
}

function ownerLabel(inst: WhatsAppInstance): string {
  return inst.owner_name ?? inst.owner_username ?? '—';
}

function canConnect(state: InstanceState): boolean {
  return state === 'notAuthorized' || state === 'starting';
}

// ---------------------------------------------------------------------------
// QR Panel
// ---------------------------------------------------------------------------

interface QrPanelProps {
  instance: WhatsAppInstance;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConnected: () => void;
}

function QrPanel({ instance, open, onOpenChange, onConnected }: QrPanelProps) {
  const [qr, setQr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!open) return;
    try {
      const r = await fetch(`/api/whatsapp/instances/${instance.id}/connection`, {
        credentials: 'include',
      });
      if (!r.ok) return;
      const data = (await r.json()) as { state: string; qr: string | null };
      if (data.state === 'authorized') {
        setConnected(true);
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        onConnected();
      } else {
        setQr(data.qr ?? null);
      }
    } catch { /* non-fatal */ }
  }, [instance.id, open, onConnected]);

  useEffect(() => {
    if (!open) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      setQr(null);
      setConnected(false);
      return;
    }
    setLoading(true);
    setConnected(false);
    setQr(null);
    void poll().finally(() => setLoading(false));
    intervalRef.current = setInterval(() => void poll(), 15_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [open, poll]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        {/* Header */}
        <div className="flex-none bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                <QrCode className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">חיבור מכשיר</SheetTitle>
                <p className="mt-0.5 text-sm text-white/70">{instance.display_name}</p>
              </div>
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
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {connected ? (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-emerald-600">
                <CheckCircle2 className="h-8 w-8" />
              </span>
              <p className="text-xl font-bold text-slate-900">מחובר!</p>
              <p className="text-sm text-muted-foreground">המכשיר חובר בהצלחה לחשבון WhatsApp.</p>
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                className="mt-2 gap-2"
              >
                סגור
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Instructions */}
              <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                <p className="font-semibold">הוראות חיבור:</p>
                <ol className="mt-2 space-y-1 list-decimal list-inside">
                  <li>פתח WhatsApp בטלפון</li>
                  <li>עבור ל-הגדרות ← מכשירים מקושרים ← קישור מכשיר</li>
                  <li>סרוק את קוד ה-QR המוצג למטה</li>
                </ol>
              </div>

              {/* QR code */}
              <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white p-6">
                {loading && !qr ? (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                    <p className="text-sm text-muted-foreground">טוען קוד QR…</p>
                  </div>
                ) : qr ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:image/png;base64,${qr}`}
                      alt="QR"
                      width={240}
                      height={240}
                      className="rounded-lg"
                    />
                    <p className="text-xs text-slate-400">
                      הקוד מתחדש כל ~20 שניות
                    </p>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <QrCode className="h-12 w-12 text-slate-300" />
                    <p className="text-sm text-muted-foreground">לא נמצא קוד QR — נסה שוב בעוד רגע</p>
                  </div>
                )}
              </div>

              <p className="text-xs text-center text-slate-400">
                הדף מתעדכן אוטומטית כל 15 שניות
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              סגור
            </Button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit Panel
// ---------------------------------------------------------------------------

interface UpsertPanelProps {
  mode: 'create' | 'edit';
  instance?: WhatsAppInstance;
  users: UserOption[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}

interface FormState {
  user_id: string;
  display_name: string;
  green_instance_id: string;
  token: string;
  api_url: string;
}

const DEFAULT_FORM: FormState = {
  user_id: '',
  display_name: '',
  green_instance_id: '',
  token: '',
  api_url: 'https://api.green-api.com',
};

function UpsertPanel({ mode, instance, users, open, onOpenChange, onDone }: UpsertPanelProps) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInlineError(null);
    if (mode === 'edit' && instance) {
      setForm({
        // Nominal webhook owner shown in the form — not an authorization input.
        // See the header of src/lib/db/whatsappInstances.ts.
        user_id: instance.user_id,
        display_name: instance.display_name,
        green_instance_id: instance.green_instance_id,
        token: '',
        api_url: instance.api_url,
      });
    } else {
      setForm(DEFAULT_FORM);
    }
  }, [open, mode, instance]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInlineError(null);
    setSaving(true);
    try {
      const isEdit = mode === 'edit' && instance;
      const url = isEdit ? `/api/whatsapp/instances/${instance.id}` : '/api/whatsapp/instances';
      const method = isEdit ? 'PATCH' : 'POST';

      let body: Partial<FormState>;
      if (isEdit) {
        // Only send changed fields; omit token if blank
        const orig = instance;
        body = {};
        if (form.display_name !== orig.display_name) body.display_name = form.display_name;
        if (form.green_instance_id !== orig.green_instance_id) body.green_instance_id = form.green_instance_id;
        if (form.api_url !== orig.api_url) body.api_url = form.api_url;
        if (form.token.trim()) body.token = form.token;
      } else {
        body = {
          user_id: form.user_id,
          display_name: form.display_name,
          green_instance_id: form.green_instance_id,
          token: form.token,
          api_url: form.api_url,
        };
      }

      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; warning?: string };

      if (!r.ok) {
        setInlineError(data.error ?? `שגיאה (HTTP ${r.status})`);
        toast.error(data.error ?? 'הפעולה נכשלה');
        return;
      }

      if (data.warning) toast.warning(data.warning);
      toast.success(mode === 'create' ? 'החיבור נוצר בהצלחה' : 'החיבור עודכן בהצלחה');
      onDone();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'שגיאה לא צפויה';
      setInlineError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const title = mode === 'create' ? 'הוסף חיבור WhatsApp' : 'עריכת חיבור WhatsApp';
  const subtitle = mode === 'create' ? 'יצירת חיבור Green API חדש לעובד' : instance?.display_name ?? '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        {/* Header */}
        <div className="flex-none bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                <Smartphone className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">{title}</SheetTitle>
                <p className="mt-0.5 text-sm text-white/70">{subtitle}</p>
              </div>
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
        </div>

        {/* Body */}
        <form id="upsert-wa-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <div className="space-y-5">
            {/* Info note */}
            <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              את ה-idInstance, ה-apiTokenInstance וכתובת ה-API יוצרים ידנית בקונסולת Green API (console.green-api.com) — צור Instance חדש לעובד והעתק את הפרטים לכאן.
            </div>

            {/* Employee (create only) */}
            {mode === 'create' && (
              <div className="space-y-1.5">
                <Label htmlFor="wa-user" className="text-base font-medium text-muted-foreground">
                  עובד<span className="text-red-500">*</span>
                </Label>
                <Select
                  value={form.user_id}
                  onValueChange={(v) => setField('user_id', v ?? '')}
                  disabled={saving}
                >
                  <SelectTrigger id="wa-user" className="w-full data-[size=default]:h-10">
                    <SelectValue placeholder="בחר עובד">
                      {(value: string | null) => {
                        if (!value) return null;
                        const u = users.find((x) => x.id === value);
                        return u ? u.label : value;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.label}
                        {u.role ? (
                          <span className="ms-1.5 text-xs text-muted-foreground">({u.role})</span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Display name */}
            <div className="space-y-1.5">
              <Label htmlFor="wa-display-name" className="text-base font-medium text-muted-foreground">
                שם לתצוגה<span className="text-red-500">*</span>
              </Label>
              <Input
                id="wa-display-name"
                value={form.display_name}
                onChange={(e) => setField('display_name', e.target.value)}
                placeholder="לדוגמה: WhatsApp של יוסי"
                className="h-10"
                disabled={saving}
                required
              />
            </div>

            {/* Instance ID */}
            <div className="space-y-1.5">
              <Label htmlFor="wa-instance-id" className="text-base font-medium text-muted-foreground">
                idInstance<span className="text-red-500">*</span>
              </Label>
              <Input
                id="wa-instance-id"
                value={form.green_instance_id}
                onChange={(e) => setField('green_instance_id', e.target.value)}
                placeholder="1234567890"
                className="h-10"
                dir="ltr"
                inputMode="numeric"
                disabled={saving}
                required
              />
            </div>

            {/* Token */}
            <div className="space-y-1.5">
              <Label htmlFor="wa-token" className="text-base font-medium text-muted-foreground">
                apiTokenInstance{mode === 'create' && <span className="text-red-500">*</span>}
              </Label>
              <Input
                id="wa-token"
                type="password"
                value={form.token}
                onChange={(e) => setField('token', e.target.value)}
                placeholder={mode === 'edit' ? 'השאר ריק כדי לא לשנות' : 'הדבק את ה-apiTokenInstance מ-Green API'}
                className="h-10"
                dir="ltr"
                disabled={saving}
                required={mode === 'create'}
              />
            </div>

            {/* API URL */}
            <div className="space-y-1.5">
              <Label htmlFor="wa-api-url" className="text-base font-medium text-muted-foreground">
                כתובת API<span className="text-red-500">*</span>
              </Label>
              <Input
                id="wa-api-url"
                value={form.api_url}
                onChange={(e) => setField('api_url', e.target.value)}
                placeholder="https://api.green-api.com"
                className="h-10"
                dir="ltr"
                disabled={saving}
                required
              />
            </div>

            {/* Inline error */}
            {inlineError && (
              <div className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-700">
                {inlineError}
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              ביטול
            </Button>
            <Button
              type="submit"
              form="upsert-wa-form"
              disabled={saving}
              className="gap-2"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? 'שומר…' : mode === 'create' ? 'צור חיבור' : 'שמור שינויים'}
            </Button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Instance Card
// ---------------------------------------------------------------------------

interface InstanceCardProps {
  instance: WhatsAppInstance;
  isAdmin: boolean;
  onConnect: (inst: WhatsAppInstance) => void;
  onEdit: (inst: WhatsAppInstance) => void;
  onLogout: (inst: WhatsAppInstance) => void;
  onDelete: (inst: WhatsAppInstance) => void;
}

function InstanceCard({ instance, isAdmin, onConnect, onEdit, onLogout, onDelete }: InstanceCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start gap-3">
        {/* Icon */}
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
          <Smartphone className="h-5 w-5" />
        </span>

        {/* Details */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900 truncate">
              {instance.display_name}
            </span>
            <StateBadge state={instance.state} />
          </div>
          {isAdmin && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {ownerLabel(instance)}
            </p>
          )}
          <p dir="ltr" className="mt-0.5 text-xs text-slate-400 tabular-nums text-start">
            idInstance: {instance.green_instance_id}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {canConnect(instance.state) && (
            <Button
              type="button"
              size="sm"
              variant="approve"
              onClick={() => onConnect(instance)}
              className="gap-1.5 h-9 px-3"
            >
              <QrCode className="h-4 w-4" />
              <span className="hidden sm:inline">חבר מכשיר</span>
            </Button>
          )}
          {instance.state === 'authorized' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onLogout(instance)}
              className="gap-1.5 h-9 px-3 text-slate-600"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">נתק</span>
            </Button>
          )}
          {isAdmin && (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onEdit(instance)}
                aria-label="ערוך"
                className="h-9 w-9 text-slate-500 hover:text-slate-700"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onDelete(instance)}
                aria-label="מחק"
                className="h-9 w-9 text-red-400 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WhatsAppConnections({
  isAdmin,
  currentUserId,
}: {
  isAdmin: boolean;
  currentUserId: string;
}) {
  const [instances, setInstances] = useState<WhatsAppInstance[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Panel states
  const [qrTarget, setQrTarget] = useState<WhatsAppInstance | null>(null);
  const [upsertMode, setUpsertMode] = useState<'create' | 'edit'>('create');
  const [upsertTarget, setUpsertTarget] = useState<WhatsAppInstance | undefined>(undefined);
  const [upsertOpen, setUpsertOpen] = useState(false);

  // AlertDialog states
  const [logoutTarget, setLogoutTarget] = useState<WhatsAppInstance | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsAppInstance | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Suppress unused-variable warning — currentUserId kept for future use
  void currentUserId;

  const loadInstances = useCallback(async () => {
    try {
      const url = isAdmin ? '/api/whatsapp/instances?manage=1' : '/api/whatsapp/instances';
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return;
      if (isAdmin) {
        const data = (await r.json()) as { instances: WhatsAppInstance[]; users: UserOption[] };
        setInstances(data.instances ?? []);
        setUsers(data.users ?? []);
      } else {
        setInstances((await r.json()) as WhatsAppInstance[]);
      }
    } catch { /* non-fatal */ } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { void loadInstances(); }, [loadInstances]);

  // Open connect QR
  function handleConnect(inst: WhatsAppInstance) {
    setQrTarget(inst);
  }

  function handleQrConnected() {
    void loadInstances();
  }

  // Open edit panel
  function handleEdit(inst: WhatsAppInstance) {
    setUpsertMode('edit');
    setUpsertTarget(inst);
    setUpsertOpen(true);
  }

  // Open create panel
  function handleCreate() {
    setUpsertMode('create');
    setUpsertTarget(undefined);
    setUpsertOpen(true);
  }

  // Logout confirm
  async function handleLogoutConfirm() {
    if (!logoutTarget) return;
    setActionBusy(true);
    try {
      const r = await fetch(`/api/whatsapp/instances/${logoutTarget.id}/connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'logout' }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(d.error ?? 'ניתוק נכשל');
        return;
      }
      toast.success('המכשיר נותק בהצלחה');
      void loadInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ניתוק נכשל');
    } finally {
      setActionBusy(false);
      setLogoutTarget(null);
    }
  }

  // Delete confirm
  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setActionBusy(true);
    try {
      const r = await fetch(`/api/whatsapp/instances/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(d.error ?? 'מחיקה נכשלה');
        return;
      }
      toast.success('החיבור נמחק');
      void loadInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'מחיקה נכשלה');
    } finally {
      setActionBusy(false);
      setDeleteTarget(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Section header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 text-emerald-600">
            <Smartphone className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-lg font-bold text-slate-900">חיבורי WhatsApp אישי</h2>
            <p className="text-sm text-muted-foreground">
              ניהול חיבורי Green API לכל עובד
            </p>
          </div>
        </div>
        {isAdmin && (
          <Button
            type="button"
            onClick={handleCreate}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            הוסף חיבור
          </Button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="mt-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-muted/60 animate-pulse" />
          ))}
        </div>
      ) : instances.length === 0 ? (
        <div className="mt-4 rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          {isAdmin
            ? 'אין חיבורי WhatsApp. לחץ על "הוסף חיבור" כדי ליצור חיבור חדש.'
            : 'אין חיבור WhatsApp מוגדר עבורך. פנה למנהל המערכת.'}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {instances.map((inst) => (
            <InstanceCard
              key={inst.id}
              instance={inst}
              isAdmin={isAdmin}
              onConnect={handleConnect}
              onEdit={handleEdit}
              onLogout={setLogoutTarget}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {/* QR Panel */}
      {qrTarget && (
        <QrPanel
          instance={qrTarget}
          open={!!qrTarget}
          onOpenChange={(v) => { if (!v) setQrTarget(null); }}
          onConnected={handleQrConnected}
        />
      )}

      {/* Create / Edit Panel */}
      <UpsertPanel
        mode={upsertMode}
        instance={upsertTarget}
        users={users}
        open={upsertOpen}
        onOpenChange={setUpsertOpen}
        onDone={loadInstances}
      />

      {/* Logout AlertDialog */}
      <AlertDialog
        open={!!logoutTarget}
        onOpenChange={(v) => { if (!v) setLogoutTarget(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לנתק את המכשיר?</AlertDialogTitle>
            <AlertDialogDescription>
              {logoutTarget?.display_name} — המכשיר ינותק מ-WhatsApp ויהיה צורך לסרוק QR מחדש.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLogoutConfirm}
              disabled={actionBusy}
              className="gap-2 bg-destructive text-white hover:bg-destructive/90"
            >
              {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              נתק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete AlertDialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את החיבור?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.display_name} — פעולה זו אינה הפיכה. החיבור יימחק לצמיתות.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={actionBusy}
              className="gap-2 bg-destructive text-white hover:bg-destructive/90"
            >
              {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              מחק לצמיתות
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
