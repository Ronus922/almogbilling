'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Save, X } from 'lucide-react';
import {
  Sheet, SheetContent, SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ColorPicker } from './ColorPicker';
import {
  validateStatusForm,
  emailsArrayToCsv,
  type StatusFormInput,
} from '@/lib/validation/status';
import type { StatusAdminRow } from '@/lib/db/statuses';

const EMPTY: StatusFormInput = {
  name: '',
  description: '',
  color: '#bfdbfe',
  is_active: true,
  notification_emails: '',
};

function fromRow(s: StatusAdminRow): StatusFormInput {
  return {
    name: s.name,
    description: s.description ?? '',
    color: s.color,
    is_active: s.is_active,
    notification_emails: emailsArrayToCsv(s.notification_emails),
  };
}

export function StatusFormSheet({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: StatusAdminRow | null;
  onSaved: () => void | Promise<void>;
}) {
  const [values, setValues] = useState<StatusFormInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);

  const initial = useMemo(() => (editing ? fromRow(editing) : EMPTY), [editing]);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setErrors({});
      setSaving(false);
    }
  }, [open, initial]);

  const isSystem = editing?.is_system === true;

  const isDirty = useMemo(() => {
    const a = values, b = initial;
    return (
      a.name !== b.name ||
      (a.description ?? '') !== (b.description ?? '') ||
      a.color.toLowerCase() !== b.color.toLowerCase() ||
      a.is_active !== b.is_active ||
      a.notification_emails !== b.notification_emails
    );
  }, [values, initial]);

  function set<K extends keyof StatusFormInput>(key: K, v: StatusFormInput[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function submit() {
    const result = validateStatusForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);

    const url = editing ? `/api/statuses/${editing.id}` : '/api/statuses';
    const method = editing ? 'PATCH' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(values),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 && body.errors) {
          setErrors(body.errors);
          return;
        }
        if (res.status === 409 && body.field === 'name') {
          setErrors({ name: body.message });
          toast.error(body.message);
          return;
        }
        toast.error(body.message || `שמירה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success(editing ? 'הסטטוס עודכן' : 'הסטטוס נוצר');
      await onSaved();
    } catch (err) {
      toast.error(`שמירה נכשלה: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function attemptClose(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (isDirty && !saving) {
      setConfirmExit(true);
      return;
    }
    onOpenChange(false);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={attemptClose}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[640px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <div className="flex-none border-b border-slate-200 bg-white px-6 py-4">
            <div className="flex items-center justify-between gap-3">
              <SheetTitle className="text-lg font-bold text-slate-900">
                {editing ? 'עריכת סטטוס' : 'סטטוס חדש'}
              </SheetTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => attemptClose(false)}
                aria-label="סגור"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-6">
            <div className="mx-auto max-w-md space-y-5">
              <Field label="שם הסטטוס" htmlFor="status-name" error={errors.name} required>
                <Input
                  id="status-name"
                  value={values.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="לדוגמה: מכתב התראה"
                  className="h-10"
                />
              </Field>

              <Field label="תיאור" htmlFor="status-desc">
                <Textarea
                  id="status-desc"
                  value={values.description ?? ''}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="תיאור קצר של הסטטוס..."
                  className="min-h-20"
                />
              </Field>

              <ColorPicker
                value={values.color}
                onChange={(hex) => set('color', hex)}
                previewName={values.name}
                error={errors.color}
              />

              <ToggleRow
                label="הסטטוס פעיל"
                hint="סטטוס לא פעיל לא יוצע ברשימות בחירה."
                checked={values.is_active}
                disabled={isSystem}
                disabledHint={isSystem ? 'סטטוס מערכת — תמיד פעיל' : null}
                onChange={(v) => set('is_active', v)}
              />

              <Field
                label="מיילים להתראה"
                htmlFor="status-emails"
                hint="כתובות מופרדות בפסיקים. תישלח התראה במעבר חייב לסטטוס זה."
                error={errors.notification_emails}
              >
                <Input
                  id="status-emails"
                  dir="ltr"
                  value={values.notification_emails}
                  onChange={(e) => set('notification_emails', e.target.value)}
                  placeholder="manager@example.com, legal@example.com"
                  className="h-10 text-start"
                />
              </Field>
            </div>
          </div>

          {/* Footer */}
          <div className="flex-none border-t border-slate-200 bg-white px-6 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => attemptClose(false)}
                disabled={saving}
              >
                ביטול
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={saving}
                className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
              >
                <Save className="h-4 w-4" />
                {saving ? 'שומר…' : 'שמור'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              ביצעת שינויים בטופס. אם תצא כעת, השינויים לא יישמרו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור לטופס</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmExit(false);
                onOpenChange(false);
              }}
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

function Field({
  label, htmlFor, required, hint, error, children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-base font-medium text-muted-foreground">
        {label}
        {required && <span className="text-red-500">*</span>}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-[12px] font-semibold text-red-500">⚠️ {error}</p>}
    </div>
  );
}

function ToggleRow({
  label, hint, checked, disabled, disabledHint, onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  disabledHint?: string | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="me-3 min-w-0">
        <Label className="text-sm font-semibold text-slate-800">{label}</Label>
        <p className="text-xs text-muted-foreground">
          {disabled && disabledHint ? disabledHint : hint}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v)}
      />
    </div>
  );
}
