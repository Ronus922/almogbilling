'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Users, X, Send, Loader2, AlertTriangle, CheckCircle2, XCircle, MinusCircle,
} from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { formatPhoneDisplay } from '@/lib/phone';
import { cleanPhoneField } from '@/lib/whatsapp';
import {
  interpolateTemplate, TEMPLATE_PLACEHOLDERS,
} from '@/lib/whatsapp-template';
import type { WhatsAppRecipient } from './WhatsAppSendPanel';
import type { WhatsAppTemplate, BulkSendProgress, BulkSendSummary } from '@/types/whatsapp';

const FREE_TEXT = '__free__';
const MAX_RECIPIENTS = 50;

type Phase = 'compose' | 'sending' | 'done';

interface ResolvedRecipient {
  recipient: WhatsAppRecipient;
  /** Clean local recipient number (owner priority), or null → will be skipped. */
  phoneLocal: string | null;
}

export function WhatsAppBulkSendPanel({
  open,
  recipients,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  recipients: WhatsAppRecipient[];
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>(FREE_TEXT);
  const [content, setContent] = useState('');
  const [phase, setPhase] = useState<Phase>('compose');
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [summary, setSummary] = useState<BulkSendSummary | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resolved: ResolvedRecipient[] = useMemo(
    () => recipients.map((recipient) => ({
      recipient,
      phoneLocal: cleanPhoneField(recipient.phone_owner) ?? cleanPhoneField(recipient.phone_tenant),
    })),
    [recipients],
  );
  const validRecipients = resolved.filter((r) => r.phoneLocal);
  const skipCount = resolved.length - validRecipients.length;
  const firstValid = validRecipients[0]?.recipient ?? null;
  const overLimit = recipients.length > MAX_RECIPIENTS;

  // Reset + load active templates whenever the panel opens.
  useEffect(() => {
    if (!open) return;
    setTemplateId(FREE_TEXT);
    setContent('');
    setPhase('compose');
    setProgress(null);
    setSummary(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/whatsapp/templates', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as WhatsAppTemplate[];
        if (!cancelled) setTemplates(data);
      } catch {
        if (!cancelled) toast.error('טעינת התבניות נכשלה');
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const preview = useMemo(
    () => (firstValid ? interpolateTemplate(content, firstValid) : content),
    [content, firstValid],
  );

  const sending = phase === 'sending';
  const canSend = content.trim().length > 0 && validRecipients.length > 0 && !overLimit && !sending;

  function requestClose() {
    if (sending) return; // don't allow closing mid-send
    onOpenChange(false);
  }
  useEscapeKey(open, () => requestClose());

  function selectTemplate(value: string | null) {
    const next = value ?? FREE_TEXT;
    setTemplateId(next);
    if (next === FREE_TEXT) { setContent(''); return; }
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

  async function handleSend() {
    if (!canSend) return;
    setPhase('sending');
    setProgress({ index: 0, total: recipients.length });
    setSummary(null);
    try {
      const res = await fetch('/api/whatsapp/send-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          debtor_ids: recipients.map((r) => r.id),
          message: content.trim(),
          template_id: templateId === FREE_TEXT ? null : templateId,
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `שליחה נכשלה (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalSummary: BulkSendSummary | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const obj = JSON.parse(line) as BulkSendProgress | BulkSendSummary;
          if (obj.type === 'progress') {
            setProgress({ index: obj.index, total: obj.total });
          } else {
            finalSummary = obj;
            setSummary(obj);
          }
        }
      }
      setPhase('done');
      if (finalSummary) {
        const { sent, failed, skipped } = finalSummary;
        if (failed === 0 && skipped === 0) toast.success(`כל ${sent} ההודעות נשלחו`);
        else toast.success(`נשלחו ${sent} · נכשלו ${failed} · דולגו ${skipped}`);
      }
      onDone?.();
    } catch (err) {
      setPhase('compose');
      toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
    }
  }

  const pct = progress && progress.total > 0
    ? Math.round((progress.index / progress.total) * 100)
    : 0;

  return (
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
                <Users className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">שליחת WhatsApp מרובה</SheetTitle>
                <p className="mt-0.5 truncate text-sm text-white/70">
                  {recipients.length} נמענים
                  {skipCount > 0 && <span className="text-white/50"> · {skipCount} ללא טלפון (ידולגו)</span>}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={sending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-40"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          {overLimit && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>נבחרו {recipients.length} נמענים. ניתן לשלוח עד {MAX_RECIPIENTS} בבת אחת — צמצם את הבחירה.</span>
            </div>
          )}

          {phase === 'done' && summary ? (
            <SummaryView summary={summary} />
          ) : sending ? (
            <SendingView pct={pct} progress={progress} />
          ) : (
            <>
              {/* Recipients list */}
              <div className="space-y-1.5">
                <Label className="text-base font-medium text-muted-foreground">נמענים</Label>
                <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2">
                  {resolved.map(({ recipient, phoneLocal }) => (
                    <li
                      key={recipient.id}
                      className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium text-slate-800">
                        דירה {recipient.apartment_number}
                        {recipient.owner_name && <span className="text-slate-400"> · {recipient.owner_name}</span>}
                      </span>
                      {phoneLocal ? (
                        <span className="shrink-0 tabular-nums text-slate-500" dir="ltr">
                          {formatPhoneDisplay(phoneLocal)}
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          <MinusCircle className="h-3 w-3" />
                          ידולג
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Template picker */}
              <div className="space-y-1.5">
                <Label className="text-base font-medium text-muted-foreground">תבנית</Label>
                <Select value={templateId} onValueChange={selectTemplate}>
                  <SelectTrigger className="w-full data-[size=default]:h-10">
                    <SelectValue placeholder="בחר תבנית או כתיבה חופשית" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FREE_TEXT}>כתיבה חופשית</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Editor */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="wa-bulk-message" className="text-base font-medium text-muted-foreground">
                    תוכן ההודעה
                  </Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TEMPLATE_PLACEHOLDERS.map((p) => (
                      <button
                        key={p.token}
                        type="button"
                        onClick={() => insertPlaceholder(p.token)}
                        className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Textarea
                  id="wa-bulk-message"
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="כתוב הודעה אחת שתישלח לכל הנמענים, עם משתנים אישיים..."
                  rows={6}
                  className="resize-none"
                  dir="rtl"
                />
              </div>

              {/* Preview (first valid recipient) */}
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">
                  תצוגה מקדימה {firstValid && <span className="text-slate-400">· דירה {firstValid.apartment_number}</span>}
                </Label>
                <div className="min-h-[88px] whitespace-pre-wrap rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 text-sm leading-relaxed text-slate-800">
                  {preview.trim().length > 0
                    ? preview
                    : <span className="text-slate-400">ההודעה תוצג כאן לאחר עריכה...</span>}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center justify-end gap-2">
            {phase === 'done' ? (
              <Button type="button" onClick={() => onOpenChange(false)} className="bg-emerald-600 text-white hover:bg-emerald-700">
                סיום
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={requestClose} disabled={sending}>
                  ביטול
                </Button>
                <Button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sending ? 'שולח…' : `שלח ל-${validRecipients.length} נמענים`}
                </Button>
              </>
            )}
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

function SendingView({ pct, progress }: { pct: number; progress: { index: number; total: number } | null }) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 text-center">
      <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-600" />
      <p className="text-sm font-semibold text-slate-800">
        שולח {progress?.index ?? 0} מתוך {progress?.total ?? 0}
      </p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="h-2 rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-slate-400">השליחה מבוצעת בהשהיה בין הודעות — אל תסגור את החלון.</p>
    </div>
  );
}

function SummaryView({ summary }: { summary: BulkSendSummary }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <SummaryStat icon={CheckCircle2} tone="emerald" label="נשלחו" value={summary.sent} />
        <SummaryStat icon={XCircle} tone="red" label="נכשלו" value={summary.failed} />
        <SummaryStat icon={MinusCircle} tone="amber" label="דולגו" value={summary.skipped} />
      </div>

      {summary.failures.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-base font-medium text-muted-foreground">פירוט כשלים</Label>
          <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-red-200 bg-red-50/50 p-3">
            {summary.failures.map((f, i) => (
              <li key={`${f.apartment}-${i}`} className="flex items-start justify-between gap-3 text-sm">
                <span className="shrink-0 font-semibold text-slate-800">דירה {f.apartment}</span>
                <span className="min-w-0 truncate text-red-600" title={f.error}>{f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const STAT_TONES = {
  emerald: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-700',
} as const;

function SummaryStat({
  icon: Icon, tone, label, value,
}: {
  icon: typeof CheckCircle2;
  tone: keyof typeof STAT_TONES;
  label: string;
  value: number;
}) {
  return (
    <div className={`flex flex-col items-center gap-1 rounded-xl p-4 ${STAT_TONES[tone]}`}>
      <Icon className="h-5 w-5" />
      <span className="text-2xl font-extrabold tabular-nums">{value}</span>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}
