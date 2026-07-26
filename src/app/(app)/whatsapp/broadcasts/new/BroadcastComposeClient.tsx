'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Megaphone, Send, Loader2, Users, Home, UserCheck, ArrowRight, Eye, CheckCircle2, OctagonX,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/whatsapp-template';
import type { Campaign } from '@/lib/wa-queue/types';
import type { WhatsAppTemplate as Tpl } from '@/types/whatsapp';
import { CampaignStatusBadge } from '../_components/StatusBadge';
import { StopBroadcastDialog } from '../_components/StopBroadcastDialog';
import { useStopBroadcast } from '../_lib/useStopBroadcast';
import { usePoll } from '../_lib/usePoll';
import { isTerminal, isCancellable, progressPct, processed } from '../_lib/status';

const FREE_TEXT = '__free__';
const AUDIENCES: { value: 'all' | 'owners' | 'tenants'; label: string; icon: typeof Users }[] = [
  { value: 'all', label: 'כל החייבים', icon: Users },
  { value: 'owners', label: 'בעלי נכסים', icon: Home },
  { value: 'tenants', label: 'שוכרים', icon: UserCheck },
];

// A fresh idempotency token per compose session — a double-click / retry POSTs the
// same token, so the server returns the SAME campaign instead of a duplicate.
function newToken(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `t-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
}

// Rendered both as the /new route page AND embedded inside the broadcast window
// (Sheet) opened from the Messages screen. `embedded` drops the page header (the
// window supplies its own); `onOpenDetail`/`onCancel` replace the route <Link>s
// with in-window navigation so the user never leaves the broadcast window.
export function BroadcastComposeClient({
  embedded = false,
  onOpenDetail,
  onCancel,
}: {
  embedded?: boolean;
  onOpenDetail?: (id: string) => void;
  onCancel?: () => void;
} = {}) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'all' | 'owners' | 'tenants'>('all');
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [templateId, setTemplateId] = useState(FREE_TEXT);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [launched, setLaunched] = useState<Campaign | null>(null);
  const tokenRef = useRef(newToken());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load templates once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/whatsapp/templates', { credentials: 'include' });
        if (r.ok) setTemplates((await r.json()) as Tpl[]);
      } catch { /* non-fatal */ }
    })();
  }, []);

  // Live eligible-recipient estimate per audience.
  useEffect(() => {
    let cancelled = false;
    setCount(null);
    (async () => {
      try {
        const r = await fetch(`/api/whatsapp/audience-count?type=${audience}`, { credentials: 'include' });
        if (!r.ok) throw new Error();
        const d = (await r.json()) as { count: number };
        if (!cancelled) setCount(d.count);
      } catch { if (!cancelled) setCount(null); }
    })();
    return () => { cancelled = true; };
  }, [audience]);

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
    requestAnimationFrame(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); });
  }

  const canSend = name.trim().length > 0 && content.trim().length > 0 && !sending && (count ?? 0) > 0;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const r = await fetch('/api/whatsapp/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          body: content.trim(),
          template_id: templateId === FREE_TEXT ? undefined : templateId,
          audience: { type: audience },
          client_token: tokenRef.current,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as Campaign & { error?: string };
      if (!r.ok) throw new Error(data.error || `יצירת תפוצה נכשלה (HTTP ${r.status})`);
      toast.success(`התפוצה יצאה לדרך — ${data.total_count} נמענים`);
      setLaunched(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'יצירת תפוצה נכשלה');
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setLaunched(null);
    setName(''); setContent(''); setTemplateId(FREE_TEXT); setAudience('all');
    tokenRef.current = newToken();
  }

  // After launch, show ONLY the active-send status for that broadcast.
  if (launched) return <LaunchedStatus initial={launched} onReset={reset} onOpenDetail={onOpenDetail} />;

  return (
    <div className={cn('space-y-6', !embedded && 'mx-auto max-w-3xl')}>
      {/* Header — the window supplies its own, so hide it when embedded. */}
      {!embedded && (
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" render={<Link href="/whatsapp/broadcasts" />} aria-label="חזרה להיסטוריה">
            <ArrowRight className="h-5 w-5" />
          </Button>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <Megaphone className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">תפוצה חדשה</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">שליחת הודעה לקבוצת נמענים דרך WhatsApp.</p>
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5">
        {/* Name */}
        <div className="space-y-1.5">
          <Label htmlFor="bc-name" className="text-base font-medium text-muted-foreground">שם התפוצה<span className="text-red-500">*</span></Label>
          <Input id="bc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: תזכורת תשלום דצמבר" className="h-10" disabled={sending} />
        </div>

        {/* Audience */}
        <div className="space-y-1.5">
          <Label className="text-base font-medium text-muted-foreground">קהל יעד</Label>
          <div className="flex flex-wrap gap-2">
            {AUDIENCES.map((a) => {
              const active = audience === a.value;
              return (
                <button key={a.value} type="button" onClick={() => setAudience(a.value)} disabled={sending}
                  className={cn('inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors',
                    active ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                  <a.icon className="h-4 w-4" /> {a.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500">
            {count === null ? 'מחשב נמענים…' : <>נמענים עם טלפון תקין: <span className="font-bold text-slate-700 tabular-nums">{count}</span></>}
          </p>
        </div>

        {/* Template */}
        <div className="space-y-1.5">
          <Label className="text-base font-medium text-muted-foreground">תבנית</Label>
          <Select value={templateId} onValueChange={selectTemplate} disabled={sending}>
            <SelectTrigger className="w-full data-[size=default]:h-10">
              <SelectValue placeholder="בחר תבנית או כתיבה חופשית">
                {(value: string | null) => (!value || value === FREE_TEXT ? 'כתיבה חופשית' : templates.find((t) => t.id === value)?.name ?? 'תבנית')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FREE_TEXT}>כתיבה חופשית</SelectItem>
              {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Message + variables */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="bc-content" className="text-base font-medium text-muted-foreground">תוכן ההודעה<span className="text-red-500">*</span></Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {TEMPLATE_PLACEHOLDERS.map((p) => (
                <button key={p.token} type="button" onClick={() => insertPlaceholder(p.token)} disabled={sending}
                  className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50">
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <Textarea id="bc-content" ref={textareaRef} value={content} onChange={(e) => setContent(e.target.value)}
            placeholder="שלום {{name}}, נותר חוב של {{debt}} בדירה {{apartment}}..." rows={18} className="min-h-48 resize-none" disabled={sending} dir="rtl" />
          <p className="text-xs text-muted-foreground">המשתנים יוחלפו אוטומטית לכל נמען. תוכן ההודעה נשמר כפי שהוא ברגע השליחה.</p>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>ביטול</Button>
        ) : (
          <Button type="button" variant="outline" render={<Link href="/whatsapp/broadcasts" />}>ביטול</Button>
        )}
        <Button type="button" onClick={handleSend} disabled={!canSend} variant="approve" className="gap-2">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? 'שולח…' : `שלח לתפוצה${count ? ` (${count})` : ''}`}
        </Button>
      </div>
    </div>
  );
}

// The just-launched broadcast's live status — polls until terminal, offers stop +
// a link to the full details. This is the ONLY place the compose screen shows send
// status (never a historical list).
function LaunchedStatus({ initial, onReset, onOpenDetail }: { initial: Campaign; onReset: () => void; onOpenDetail?: (id: string) => void }) {
  const fetcher = useCallback(async (): Promise<Campaign> => {
    const r = await fetch(`/api/whatsapp/campaigns/${initial.id}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`טעינת הסטטוס נכשלה (HTTP ${r.status})`);
    return (await r.json()) as Campaign;
  }, [initial.id]);

  const { data, refetch } = usePoll<Campaign>(fetcher, {
    intervalMs: 3000,
    shouldContinue: (d) => !isTerminal(d.status),
    deps: [initial.id],
  });
  const c = data ?? initial;
  const stop = useStopBroadcast(() => void refetch());
  const done = isTerminal(c.status);
  const cancellable = isCancellable(c.status);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', done ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600')}>
          {done ? <CheckCircle2 className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
        </span>
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">{c.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{done ? 'התפוצה הסתיימה.' : 'התפוצה בשליחה…'}</p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <CampaignStatusBadge status={c.status} />
          <span className="text-sm text-slate-500 tabular-nums">{processed(c)} מתוך {c.total_count} · {progressPct(c)}%</span>
        </div>
        <Progress value={progressPct(c)} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="נשלחו" value={c.sent_count} tone="text-emerald-700" />
          <Stat label="נכשלו" value={c.failed_count} tone="text-red-600" />
          <Stat label="בוטלו" value={c.cancelled_count} tone="text-slate-600" />
          <Stat label="סך הכול" value={c.total_count} tone="text-slate-700" />
        </div>
        {c.status === 'cancelled' && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            התפוצה נעצרה — {c.sent_count} נשלחו, {c.failed_count} נכשלו, {c.cancelled_count} בוטלו לפני שליחה.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {cancellable && (
          <Button type="button" onClick={() => stop.request(c)} className="gap-2 bg-destructive text-white hover:bg-destructive/90">
            <OctagonX className="h-4 w-4" /> עצירת התפוצה
          </Button>
        )}
        {onOpenDetail ? (
          <Button type="button" variant="outline" onClick={() => onOpenDetail(c.id)} className="gap-2">
            <Eye className="h-4 w-4" /> צפייה בלוג
          </Button>
        ) : (
          <Button type="button" variant="outline" render={<Link href={`/whatsapp/broadcasts/${c.id}`} />} className="gap-2">
            <Eye className="h-4 w-4" /> צפייה בפרטים
          </Button>
        )}
        <Button type="button" variant="approve" onClick={onReset} className="gap-2">
          <Megaphone className="h-4 w-4" /> תפוצה חדשה
        </Button>
      </div>

      <StopBroadcastDialog
        open={stop.target !== null}
        onOpenChange={(o) => { if (!o) stop.close(); }}
        counts={stop.counts}
        pending={stop.pending}
        onConfirm={() => void stop.confirm()}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-100 bg-slate-50 p-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={cn('text-lg font-bold tabular-nums', tone)}>{value}</span>
    </div>
  );
}
