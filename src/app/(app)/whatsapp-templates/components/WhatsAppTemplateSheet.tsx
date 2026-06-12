'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Save, X, MessageSquareText } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/whatsapp-template';
import type { WhatsAppTemplate } from '@/types/whatsapp';

interface FormState {
  name: string;
  content: string;
  is_active: boolean;
}

const EMPTY: FormState = { name: '', content: '', is_active: true };

function fromTemplate(t: WhatsAppTemplate): FormState {
  return { name: t.name, content: t.content, is_active: t.is_active };
}

export function WhatsAppTemplateSheet({
  open,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  editing: WhatsAppTemplate | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [values, setValues] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  const initial = useMemo(() => (editing ? fromTemplate(editing) : EMPTY), [editing]);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setSaving(false);
      setConfirmExit(false);
    }
  }, [open, initial]);

  const isDirty = useMemo(() => (
    values.name !== initial.name ||
    values.content !== initial.content ||
    values.is_active !== initial.is_active
  ), [values, initial]);

  function set<K extends keyof FormState>(key: K, v: FormState[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function insertPlaceholder(token: string) {
    const el = contentRef.current;
    if (!el) {
      setValues((prev) => ({ ...prev, content: prev.content + token }));
      return;
    }
    const start = el.selectionStart ?? values.content.length;
    const end = el.selectionEnd ?? values.content.length;
    const next = values.content.slice(0, start) + token + values.content.slice(end);
    set('content', next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function attemptClose(next: boolean) {
    if (next) { onOpenChange(true); return; }
    if (isDirty && !saving) { setConfirmExit(true); return; }
    onOpenChange(false);
  }

  useEscapeKey(open && !confirmExit, () => attemptClose(false));
  useEscapeKey(confirmExit, () => setConfirmExit(false));

  async function submit() {
    const name = values.name.trim();
    const content = values.content.trim();
    if (name.length < 1 || name.length > 80) {
      toast.error('שם התבנית חייב להיות באורך 1-80 תווים');
      return;
    }
    if (content.length < 1 || content.length > 4096) {
      toast.error('תוכן התבנית חייב להיות באורך 1-4096 תווים');
      return;
    }

    setSaving(true);
    const url = editing ? `/api/whatsapp/templates/${editing.id}` : '/api/whatsapp/templates';
    const method = editing ? 'PATCH' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, content, is_active: values.is_active }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `שמירה נכשלה (HTTP ${res.status})`);
      toast.success(editing ? 'התבנית עודכנה' : 'התבנית נוצרה');
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'שמירה נכשלה');
    } finally {
      setSaving(false);
    }
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
          {/* Header — gradient (DESIGN canonical, matches the tenant detail panel) */}
          <div className="flex-none bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                  <MessageSquareText className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <SheetTitle className="text-xl font-bold text-white">
                    {editing ? 'עריכת תבנית' : 'תבנית חדשה'}
                  </SheetTitle>
                  <p className="mt-0.5 text-sm text-white/70">תבנית הודעת WhatsApp</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => attemptClose(false)}
                aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-6">
            <div className="mx-auto max-w-lg space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name" className="text-base font-medium text-muted-foreground">
                  שם התבנית<span className="text-red-500">*</span>
                </Label>
                <Input
                  id="tpl-name"
                  value={values.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="לדוגמה: תזכורת תשלום"
                  className="h-10"
                  disabled={saving}
                />
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="tpl-content" className="text-base font-medium text-muted-foreground">
                    תוכן<span className="text-red-500">*</span>
                  </Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TEMPLATE_PLACEHOLDERS.map((p) => (
                      <button
                        key={p.token}
                        type="button"
                        onClick={() => insertPlaceholder(p.token)}
                        disabled={saving}
                        className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Textarea
                  id="tpl-content"
                  ref={contentRef}
                  value={values.content}
                  onChange={(e) => set('content', e.target.value)}
                  placeholder="שלום {{name}}, נותר חוב של {{debt}}. דמי ניהול: {{monthly}}..."
                  rows={6}
                  className="resize-none"
                  disabled={saving}
                  dir="rtl"
                />
                <p className="text-xs text-muted-foreground">
                  משתנים נתמכים:{' '}
                  {TEMPLATE_PLACEHOLDERS.map((p, i) => (
                    <span key={p.token}>
                      {i > 0 && ', '}
                      <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-600" dir="ltr">{p.token}</code>
                    </span>
                  ))}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <div className="me-3 min-w-0">
                  <Label className="text-sm font-semibold text-slate-800">תבנית פעילה</Label>
                  <p className="text-xs text-muted-foreground">תבנית לא פעילה לא תוצע במסך השליחה.</p>
                </div>
                <Switch
                  checked={values.is_active}
                  onCheckedChange={(v) => set('is_active', v)}
                  disabled={saving}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex-none border-t border-slate-200 bg-white px-6 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => attemptClose(false)} disabled={saving}>
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
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>ביצעת שינויים בטופס. אם תצא כעת, השינויים לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור לטופס</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmExit(false); onOpenChange(false); }}
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
