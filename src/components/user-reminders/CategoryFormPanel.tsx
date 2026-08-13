'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, Tag, Check, Pipette } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { COLOR_HEX_RE } from '@/lib/validation/status';
import { REMINDER_CATEGORY_COLORS } from '@/lib/constants/userReminders';
import type { ReminderCategory } from '@/lib/types/reminderCategories';
import { reminderErrorMessage } from './helpers';

interface Props {
  open: boolean;
  /** Edit target — when present the panel edits; otherwise it creates. */
  category?: ReminderCategory | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

const DEFAULT_COLOR = REMINDER_CATEGORY_COLORS[0].hex;

export function CategoryFormPanel({ open, category = null, onOpenChange, onSaved }: Props) {
  const isEdit = !!category;
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(category?.name ?? '');
      setColor(category?.color ?? DEFAULT_COLOR);
      setTouched(false);
      setSubmitting(false);
    }
  }, [open, category]);

  const trimmed = name.trim();
  const colorValid = COLOR_HEX_RE.test(color);
  const nameError = touched && !trimmed ? 'יש להזין שם קטגוריה' : null;
  const colorError = touched && !colorValid ? 'צבע לא תקין' : null;
  const canSubmit = !!trimmed && trimmed.length <= 60 && colorValid && !submitting;

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (submitting) return;
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTouched(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = isEdit
        ? await fetch(`/api/reminder-categories/${category!.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name: trimmed, color }),
          })
        : await fetch('/api/reminder-categories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name: trimmed, color }),
          });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(reminderErrorMessage(data.error));

      toast.success(isEdit ? 'הקטגוריה עודכנה' : 'הקטגוריה נוצרה');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const previewBg = colorValid ? color : '#e5e7eb';

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">
                {isEdit ? 'עריכת קטגוריה' : 'קטגוריה חדשה'}
              </SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                {isEdit ? 'עדכן את שם וצבע הקטגוריה.' : 'תן שם וצבע לקטגוריית תזכורות.'}
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

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="פרטי הקטגוריה" icon={Tag} iconTone="violet">
            <div className="space-y-5 py-2">
              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="cat-name" className="text-base font-medium text-muted-foreground">
                  שם הקטגוריה<span className="text-red-500"> *</span>
                </Label>
                <Input
                  id="cat-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched(true)}
                  disabled={submitting}
                  autoFocus
                  maxLength={60}
                  placeholder="לדוגמה: שיחות חוזרות, גביה, תחזוקה"
                  className={cn('h-10', nameError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                />
                {nameError && (
                  <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {nameError}</p>
                )}
              </div>

              {/* Color picker */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-base font-medium text-muted-foreground">צבע</Label>
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                    <span
                      className="h-4 w-4 rounded-full ring-1 ring-slate-200"
                      style={{ backgroundColor: previewBg }}
                    />
                    {trimmed || 'תצוגה מקדימה'}
                  </span>
                </div>

                <div className="grid grid-cols-6 gap-2">
                  {REMINDER_CATEGORY_COLORS.map((c) => {
                    const selected = c.hex.toLowerCase() === color.toLowerCase();
                    return (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setColor(c.hex)}
                        aria-label={c.label}
                        aria-pressed={selected}
                        disabled={submitting}
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
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    onBlur={() => setTouched(true)}
                    disabled={submitting}
                    placeholder="#3D5AFE"
                    maxLength={7}
                    className={cn(
                      'h-9 font-mono text-sm tabular-nums',
                      colorError && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                    )}
                  />
                </div>
                {colorError && (
                  <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {colorError}</p>
                )}
              </div>
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={handleSubmit}
          saveDisabled={!canSubmit}
          saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור קטגוריה'}
        />
      </SheetContent>
    </Sheet>
  );
}
