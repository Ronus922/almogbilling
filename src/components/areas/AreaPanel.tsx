'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { X, MapPin, Check, Pipette, Ban } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { COLOR_HEX_RE } from '@/lib/validation/status';
import { AREA_TYPES, AREA_COLORS, AREA_NO_COLOR, areaTypeLabel } from '@/lib/constants/areas';
import type { Area, AreaType } from '@/lib/types/areas';

interface Props {
  open: boolean;
  /** null = create mode; an area = edit mode. */
  area: Area | null;
  canEdit: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  area_type: AreaType;
  description: string;
  /** '' = no color (stored as null). */
  color: string;
}

function initialForm(area: Area | null): FormState {
  return {
    name: area?.name ?? '',
    area_type: area?.area_type ?? 'closed_room',
    description: area?.description ?? '',
    color: area?.color ?? '',
  };
}

// Server error codes → short Hebrew toast messages.
function errorLabel(code: string | undefined, isEdit: boolean): string {
  switch (code) {
    case 'name_required': return 'שם האזור הוא שדה חובה';
    case 'name_too_long': return 'שם האזור ארוך מדי';
    case 'area_type_required':
    case 'invalid_area_type': return 'יש לבחור סוג אזור';
    case 'description_too_long': return 'התיאור ארוך מדי';
    case 'invalid_color': return 'צבע לא תקין';
    case 'not_found': return 'האזור לא נמצא';
    default: return isEdit ? 'עדכון האזור נכשל' : 'יצירת האזור נכשלה';
  }
}

export function AreaPanel({ open, area, canEdit, onOpenChange, onSaved }: Props) {
  const isEdit = !!area;
  const baseline = useMemo(() => initialForm(area), [area]);

  const [form, setForm] = useState<FormState>(baseline);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  // Fresh form on every open (and when switching between create/edit targets).
  useEffect(() => {
    if (open) {
      setForm(initialForm(area));
      setTouched(false);
      setSubmitting(false);
    }
  }, [open, area]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const nameError = !form.name.trim() ? 'שם האזור הוא שדה חובה' : null;
  const colorValid = form.color === '' || COLOR_HEX_RE.test(form.color);
  const colorError = !colorValid ? 'צבע לא תקין' : null;

  const showNameError = touched ? nameError : null;
  const showColorError = touched ? colorError : null;
  const canSubmit = !nameError && colorValid && !submitting && canEdit;

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  );

  // Defensive ESC: panel listens unless the cancel-confirm dialog is open.
  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTouched(true);
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        area_type: form.area_type,
        description: form.description.trim() || null,
        color: form.color.trim() || null,
      };

      const url = isEdit ? `/api/areas/${area!.id}` : '/api/areas';
      const r = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(errorLabel(data.error, isEdit));

      toast.success(isEdit ? 'האזור עודכן' : 'האזור נוצר');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const previewBg = form.color && colorValid ? form.color : AREA_NO_COLOR;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? 'עריכת אזור' : 'אזור חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {isEdit
                    ? 'עדכנו את שם האזור, הסוג, התיאור והצבע.'
                    : 'הגדירו אזור חדש בבניין — שם, סוג, תיאור וצבע.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <Section title="פרטי האזור" icon={MapPin} iconTone="blue">
              <div className="space-y-5 py-2">
                {/* Name */}
                <div className="space-y-2">
                  <Label htmlFor="area-name" className="text-base font-medium text-muted-foreground">
                    שם האזור
                    <span className="text-red-500"> *</span>
                  </Label>
                  <Input
                    id="area-name"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                    onBlur={() => setTouched(true)}
                    disabled={!canEdit || submitting}
                    autoFocus
                    maxLength={120}
                    placeholder="לדוגמה: חדר מדרגות א׳ / חניון תת-קרקעי / גינה"
                    className={cn(
                      'h-10',
                      showNameError && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                    )}
                  />
                  {showNameError && (
                    <p className="text-[12px] font-semibold text-red-500 text-start">
                      ⚠️ {showNameError}
                    </p>
                  )}
                </div>

                {/* Type */}
                <div className="space-y-2">
                  <Label className="text-base font-medium text-muted-foreground">
                    סוג האזור
                    <span className="text-red-500"> *</span>
                  </Label>
                  <Select
                    value={form.area_type}
                    onValueChange={(v) => { if (v) set('area_type', v as AreaType); }}
                    disabled={!canEdit || submitting}
                  >
                    <SelectTrigger className="w-full data-[size=default]:h-10">
                      <SelectValue placeholder="בחרו סוג אזור...">
                        {(value: string | null) => (value ? areaTypeLabel(value as AreaType) : null)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {AREA_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Color picker (optional) */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-base font-medium text-muted-foreground">צבע כרטיס</Label>
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                      <span
                        className="h-4 w-4 rounded-full ring-1 ring-slate-200"
                        style={{ backgroundColor: previewBg }}
                      />
                      {form.color ? 'תצוגה מקדימה' : 'ללא צבע'}
                    </span>
                  </div>

                  <div className="grid grid-cols-6 gap-2">
                    {/* "No color" option */}
                    <button
                      type="button"
                      onClick={() => set('color', '')}
                      aria-label="ללא צבע"
                      aria-pressed={form.color === ''}
                      disabled={!canEdit || submitting}
                      className={cn(
                        'relative grid h-9 place-items-center rounded-lg bg-white text-slate-400 ring-1 ring-slate-200 transition-shadow hover:ring-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                        form.color === '' && 'ring-2 ring-blue-600 ring-offset-1',
                      )}
                    >
                      <Ban className="h-4 w-4" />
                    </button>

                    {AREA_COLORS.map((c) => {
                      const selected = c.hex.toLowerCase() === form.color.toLowerCase();
                      return (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => set('color', c.hex)}
                          aria-label={`בחירת צבע ${c.hex}`}
                          aria-pressed={selected}
                          disabled={!canEdit || submitting}
                          className={cn(
                            'relative h-9 rounded-lg ring-1 ring-slate-200 transition-shadow hover:ring-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                            selected && 'ring-2 ring-blue-600 ring-offset-1',
                          )}
                          style={{ backgroundColor: c.hex }}
                        >
                          {selected && <Check className="absolute inset-0 m-auto h-4 w-4 text-white" />}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <Pipette className="h-4 w-4 text-slate-400" />
                    <Input
                      dir="ltr"
                      value={form.color}
                      onChange={(e) => set('color', e.target.value)}
                      onBlur={() => setTouched(true)}
                      disabled={!canEdit || submitting}
                      placeholder="#3D5AFE"
                      maxLength={7}
                      className={cn(
                        'h-9 font-mono text-sm tabular-nums',
                        showColorError && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                      )}
                    />
                  </div>
                  {showColorError && (
                    <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {showColorError}</p>
                  )}
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="area-description" className="text-base font-medium text-muted-foreground">
                    תיאור
                  </Label>
                  <Textarea
                    id="area-description"
                    value={form.description}
                    onChange={(e) => set('description', e.target.value)}
                    disabled={!canEdit || submitting}
                    className="min-h-24"
                    placeholder="תיאור קצר של האזור (אופציונלי)"
                  />
                </div>
              </div>
            </Section>
          </div>

          {/* Footer */}
          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה לעריכה' : undefined}
            saveLabel={
              isEdit
                ? (submitting ? 'שומר…' : 'שמור שינויים')
                : (submitting ? 'יוצר…' : 'צור אזור')
            }
          />
        </SheetContent>
      </Sheet>

      {/* Confirm discard on close-while-dirty */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>{isEdit ? 'לבטל את העריכה?' : 'לבטל יצירת אזור?'}</AlertDialogTitle>
            <AlertDialogDescription>
              השינויים שביצעת לא יישמרו. ניתן להמשיך לערוך בכל עת.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              בטל
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
