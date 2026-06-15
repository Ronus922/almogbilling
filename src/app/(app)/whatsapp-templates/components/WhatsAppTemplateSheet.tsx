'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Save, X, MessageSquareText, Eye, Home, CheckCheck, Plus } from 'lucide-react';
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
import { cn } from '@/lib/utils';
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
          <div className="flex-1 overflow-y-auto bg-surface-2 p-6">
            <div className="@container mx-auto max-w-5xl">
              <div className="grid gap-6 @2xl:grid-cols-[minmax(0,1fr)_19rem]">
                {/* ── Form column (right in RTL) ─────────────────────── */}
                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="tpl-name" className="text-[13.5px] font-bold text-ink-2">
                      שם התבנית<span className="text-[#e5484d]">*</span>
                    </Label>
                    <Input
                      id="tpl-name"
                      value={values.name}
                      onChange={(e) => set('name', e.target.value)}
                      placeholder="לדוגמה: תזכורת תשלום"
                      className="h-10 border-[1.5px] border-line bg-white text-sm placeholder:text-ink-ghost focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]"
                      disabled={saving}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tpl-content" className="text-[13.5px] font-bold text-ink-2">
                      תוכן<span className="text-[#e5484d]">*</span>
                    </Label>
                    {/* Variable insert chips — above the textarea */}
                    <div className="flex flex-wrap items-center gap-2">
                      {TEMPLATE_PLACEHOLDERS.map((p) => (
                        <button
                          key={p.token}
                          type="button"
                          onClick={() => insertPlaceholder(p.token)}
                          disabled={saving}
                          className="inline-flex items-center gap-1 rounded-full border border-brand-border bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:border-brand hover:bg-brand hover:text-white hover:shadow-soft-sm disabled:opacity-50"
                        >
                          <span>{p.label}</span>
                          <Plus className="h-3 w-3 opacity-70" />
                        </button>
                      ))}
                    </div>
                    <Textarea
                      id="tpl-content"
                      ref={contentRef}
                      value={values.content}
                      onChange={(e) => set('content', e.target.value)}
                      placeholder="שלום {{name}}, נותר חוב של {{debt}}. דמי ניהול: {{monthly}}..."
                      rows={6}
                      className="min-h-[184px] resize-none border-[1.5px] border-line bg-white text-sm leading-[1.85] placeholder:text-ink-ghost focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]"
                      disabled={saving}
                      dir="rtl"
                    />
                    {/* Supported variables */}
                    <div className="flex flex-wrap items-center gap-1.5 rounded-[7px] border border-line-soft bg-surface-2 px-3 py-2">
                      <span className="text-xs text-ink-3">משתנים נתמכים:</span>
                      {TEMPLATE_PLACEHOLDERS.map((p) => (
                        <code
                          key={p.token}
                          dir="ltr"
                          className="rounded-[5px] border border-line bg-white px-1.5 py-0.5 font-num text-[11px] text-ink-2"
                        >
                          {p.token}
                        </code>
                      ))}
                    </div>
                  </div>

                  {/* Active toggle card */}
                  <div
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-xl border p-4 transition-colors',
                      values.is_active
                        ? 'border-[#beedcf] bg-gradient-to-bl from-[#e9fbf0] to-white'
                        : 'border-line bg-white',
                    )}
                  >
                    <div className="me-3 min-w-0">
                      <Label className="text-sm font-bold text-ink">תבנית פעילה</Label>
                      <p className="mt-0.5 text-xs text-ink-2">תבנית לא פעילה לא תוצע במסך השליחה.</p>
                    </div>
                    <Switch
                      size="lg"
                      checked={values.is_active}
                      onCheckedChange={(v) => set('is_active', v)}
                      disabled={saving}
                      className="data-checked:bg-[#16a34a]"
                    />
                  </div>
                </div>

                {/* ── Preview column (left in RTL) ───────────────────── */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-ink-3">
                    <Eye className="h-4 w-4" />
                    <span className="text-xs font-semibold">תצוגה מקדימה</span>
                  </div>
                  <MessagePreview content={values.content} />
                </div>
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
                className="gap-2"
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

/** Static stamp for the preview chrome (preview is a mock, not a sent message). */
const PREVIEW_TIME = '10:30';

/** Splits template content into plain text + highlighted {{token}} spans. */
function renderTemplateParts(content: string) {
  return content.split(/(\{\{[^}]+\}\})/g).map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span
        key={i}
        dir="ltr"
        className="rounded bg-brand-soft px-1 font-num font-semibold text-brand-text"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Live WhatsApp message preview — a pure render of the composer content. */
function MessagePreview({ content }: { content: string }) {
  const hasContent = content.trim().length > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-line shadow-soft-md">
      {/* Phone top bar */}
      <div className="flex items-center gap-3 bg-gradient-to-l from-[#075e54] to-[#054c44] px-4 py-3 text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15">
          <Home className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight">חברת הניהול</div>
          <div className="text-[11px] text-white/70">מקוון</div>
        </div>
      </div>
      {/* Chat surface */}
      <div
        className="min-h-[200px] p-4"
        style={{
          backgroundColor: '#e5ddd5',
          backgroundImage: 'radial-gradient(rgba(0,0,0,0.045) 1px, transparent 1px)',
          backgroundSize: '14px 14px',
        }}
      >
        <div className="me-auto max-w-[88%] rounded-ss-[12px] rounded-se-[12px] rounded-ee-[12px] rounded-es-[3px] bg-[#dcf8c6] px-3 py-2 shadow-soft-xs">
          <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.7] text-[#111b21]">
            {hasContent ? renderTemplateParts(content) : (
              <span className="text-[#667781]">תוכן ההודעה יוצג כאן…</span>
            )}
          </p>
          <div className="mt-1 flex items-center justify-end gap-1 text-[#667781]">
            <span className="font-num text-[11px]">{PREVIEW_TIME}</span>
            <CheckCheck className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
    </div>
  );
}
