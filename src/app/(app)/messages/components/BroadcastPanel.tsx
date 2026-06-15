'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Megaphone, X, Send, Loader2, Users, Home, UserCheck,
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
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/whatsapp-template';
import { cn } from '@/lib/utils';
import type { WhatsAppTemplate, Broadcast, BroadcastAudienceType } from '@/types/whatsapp';

const FREE_TEXT = '__free__';

const AUDIENCES: { value: BroadcastAudienceType; label: string; icon: typeof Users }[] = [
  { value: 'all', label: 'כל החייבים', icon: Users },
  { value: 'owners', label: 'בעלי נכסים', icon: Home },
  { value: 'tenants', label: 'שוכרים', icon: UserCheck },
];

const STATUS_META: Record<Broadcast['status'], { label: string; cls: string }> = {
  pending:   { label: 'ממתין',  cls: 'bg-slate-100 text-slate-600' },
  running:   { label: 'בשליחה', cls: 'bg-blue-100 text-blue-700' },
  completed: { label: 'הושלם',  cls: 'bg-emerald-100 text-emerald-700' },
  failed:    { label: 'נכשל',   cls: 'bg-red-100 text-red-700' },
};

export function BroadcastPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<BroadcastAudienceType>('all');
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState(FREE_TEXT);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isDirty = name.trim().length > 0 || content.trim().length > 0;

  const loadBroadcasts = useCallback(async () => {
    try {
      const r = await fetch('/api/whatsapp/broadcasts', { credentials: 'include' });
      if (!r.ok) return;
      setBroadcasts((await r.json()) as Broadcast[]);
    } catch { /* non-fatal */ }
  }, []);

  // Reset + initial loads on open.
  useEffect(() => {
    if (!open) return;
    setName('');
    setAudience('all');
    setTemplateId(FREE_TEXT);
    setContent('');
    setSending(false);
    setConfirmClose(false);
    (async () => {
      try {
        const r = await fetch('/api/whatsapp/templates', { credentials: 'include' });
        if (r.ok) setTemplates((await r.json()) as WhatsAppTemplate[]);
      } catch { /* non-fatal */ }
    })();
    void loadBroadcasts();
  }, [open, loadBroadcasts]);

  // Live recipient count per audience.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCount(null);
    (async () => {
      try {
        const r = await fetch(`/api/whatsapp/audience-count?type=${audience}`, { credentials: 'include' });
        if (!r.ok) throw new Error();
        const d = (await r.json()) as { count: number };
        if (!cancelled) setCount(d.count);
      } catch {
        if (!cancelled) setCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [audience, open]);

  // Poll broadcast progress while the panel is open.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => void loadBroadcasts(), 3000);
    return () => clearInterval(id);
  }, [open, loadBroadcasts]);

  function requestClose() {
    if (sending) return;
    if (isDirty) setConfirmClose(true);
    else onOpenChange(false);
  }
  useEscapeKey(open && !confirmClose, () => requestClose());
  useEscapeKey(confirmClose, () => setConfirmClose(false));

  function selectTemplate(value: string | null) {
    const next = value ?? FREE_TEXT;
    setTemplateId(next);
    if (next === FREE_TEXT) return;
    const tpl = templates.find((t) => t.id === next);
    if (tpl) setContent(tpl.content);
  }

  function insertPlaceholder(token: string) {
    const el = textareaRef.current;
    if (!el) { setContent((c) => c + token); return; }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + token + content.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const canSend = name.trim().length > 0 && content.trim().length > 0 && !sending && (count ?? 0) > 0;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const r = await fetch('/api/whatsapp/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          body: content.trim(),
          audience: { type: audience },
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; total_count?: number };
      if (!r.ok) throw new Error(data.error || `יצירת תפוצה נכשלה (HTTP ${r.status})`);
      toast.success(`התפוצה יצאה לדרך — ${data.total_count ?? count ?? 0} נמענים`);
      setName('');
      setContent('');
      setTemplateId(FREE_TEXT);
      await loadBroadcasts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'יצירת תפוצה נכשלה');
    } finally {
      setSending(false);
    }
  }

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
          <div className="flex-none bg-gradient-to-bl from-emerald-900 via-emerald-800 to-green-700 px-6 py-5 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                  <Megaphone className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <SheetTitle className="text-xl font-bold text-white">תפוצת WhatsApp</SheetTitle>
                  <p className="mt-0.5 text-sm text-white/70">שליחת הודעה לקבוצת נמענים</p>
                </div>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="bc-name" className="text-base font-medium text-muted-foreground">
                שם התפוצה<span className="text-red-500">*</span>
              </Label>
              <Input
                id="bc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="לדוגמה: תזכורת תשלום דצמבר"
                className="h-10"
                disabled={sending}
              />
            </div>

            {/* Audience */}
            <div className="space-y-1.5">
              <Label className="text-base font-medium text-muted-foreground">קהל יעד</Label>
              <div className="flex flex-wrap gap-2">
                {AUDIENCES.map((a) => {
                  const active = audience === a.value;
                  return (
                    <button
                      key={a.value}
                      type="button"
                      onClick={() => setAudience(a.value)}
                      disabled={sending}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors',
                        active
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      <a.icon className="h-4 w-4" /> {a.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">
                {count === null ? 'מחשב נמענים…' : (
                  <>נמענים עם טלפון תקין: <span className="font-bold text-slate-700 tabular-nums">{count}</span></>
                )}
              </p>
            </div>

            {/* Template / free text */}
            <div className="space-y-1.5">
              <Label className="text-base font-medium text-muted-foreground">תבנית</Label>
              <Select value={templateId} onValueChange={selectTemplate} disabled={sending}>
                <SelectTrigger className="w-full data-[size=default]:h-10">
                  <SelectValue placeholder="בחר תבנית או כתיבה חופשית">
                    {(value: string | null) => {
                      if (!value || value === FREE_TEXT) return 'כתיבה חופשית';
                      return templates.find((t) => t.id === value)?.name ?? 'תבנית';
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FREE_TEXT}>כתיבה חופשית</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Message */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="bc-content" className="text-base font-medium text-muted-foreground">
                  תוכן ההודעה<span className="text-red-500">*</span>
                </Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {TEMPLATE_PLACEHOLDERS.map((p) => (
                    <button
                      key={p.token}
                      type="button"
                      onClick={() => insertPlaceholder(p.token)}
                      disabled={sending}
                      className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <Textarea
                id="bc-content"
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="שלום {{name}}, נותר חוב של {{debt}} בדירה {{apartment}}..."
                rows={5}
                className="resize-none"
                disabled={sending}
                dir="rtl"
              />
              <p className="text-xs text-muted-foreground">המשתנים יוחלפו אוטומטית לכל נמען.</p>
            </div>

            {/* Recent broadcasts with progress */}
            {broadcasts.length > 0 && (
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">תפוצות אחרונות</Label>
                <div className="space-y-2">
                  {broadcasts.map((b) => {
                    const done = b.sent_count + b.failed_count;
                    const pct = b.total_count > 0 ? Math.round((done / b.total_count) * 100) : 0;
                    const meta = STATUS_META[b.status];
                    return (
                      <div key={b.id} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-slate-900">{b.name}</span>
                          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', meta.cls)}>
                            {meta.label}
                          </span>
                        </div>
                        <Progress value={pct} className="mt-2" />
                        <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
                          <span>{done}/{b.total_count} נשלחו</span>
                          {b.failed_count > 0 && <span className="text-red-500">{b.failed_count} נכשלו</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={requestClose} disabled={sending}>
                סגור
              </Button>
              <Button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                variant="approve"
                className="gap-2"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {sending ? 'שולח…' : `שלח לתפוצה${count ? ` (${count})` : ''}`}
              </Button>
            </div>
          </footer>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שליחה?</AlertDialogTitle>
            <AlertDialogDescription>הזנת פרטי תפוצה שלא נשלחה. אם תצא עכשיו, התוכן יאבד.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור לעריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmClose(false); onOpenChange(false); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שליחה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
