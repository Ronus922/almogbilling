'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Megaphone, Send, Loader2, Home, UserCheck, Truck, ArrowRight, Eye, CheckCircle2, OctagonX,
  MessageCircle, Mail, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { TEMPLATE_PLACEHOLDERS, emailSubjectError } from '@/lib/whatsapp-template';
import { isValidMinDebtAmount, MIN_DEBT_AMOUNT_ERROR } from '@/lib/whatsapp-audience-filter';
import {
  EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES, WHATSAPP_ATTACHMENT_LIMITS, validateBroadcastAttachmentSet,
} from '@/lib/constants/whatsappAttachments';
import type { BroadcastChannel, Campaign } from '@/lib/wa-queue/types';
import type { BroadcastDebtFilter, MissingEmailEntry, WhatsAppTemplate as Tpl } from '@/types/whatsapp';
import { CampaignStatusBadge } from '@/app/(app)/broadcasts/_components/StatusBadge';
import { StopBroadcastDialog } from '@/app/(app)/broadcasts/_components/StopBroadcastDialog';
import {
  AttachmentPicker, readyAttachmentIds, isUploading, type StagedAttachment,
  EMAIL_BROADCAST_ATTACHMENT_POLICY, WHATSAPP_ATTACHMENT_POLICY,
} from '@/components/whatsapp/AttachmentPicker';
import { useStopBroadcast } from '@/app/(app)/broadcasts/_lib/useStopBroadcast';
import { usePoll } from '@/app/(app)/broadcasts/_lib/usePoll';
import { isTerminal, isCancellable, progressPct, processed } from '@/app/(app)/broadcasts/_lib/status';

const FREE_TEXT = '__free__';
type Role = 'owners' | 'tenants' | 'suppliers';
const ROLES: { value: Role; label: string; icon: typeof Home }[] = [
  { value: 'owners', label: 'בעלי נכסים', icon: Home },
  { value: 'tenants', label: 'שוכרים', icon: UserCheck },
  { value: 'suppliers', label: 'ספקים', icon: Truck },
];
const DEFAULT_ROLES: Role[] = ['owners', 'tenants'];

// The channel is a property of the broadcast (09/10/2026): everything below it
// — audience, template, message, files, send — is the same form for both.
const CHANNELS: { value: BroadcastChannel; label: string; icon: typeof Home }[] = [
  { value: 'whatsapp', label: 'וואטסאפ', icon: MessageCircle },
  { value: 'email', label: 'מייל', icon: Mail },
];

const MISSING_ROLE_LABEL: Record<MissingEmailEntry['role'], string> = {
  owner: 'בעלים',
  tenant: 'שוכר',
  supplier: 'ספק',
};

/** One line of the "ללא אימייל" list — where to go and fill the address in. */
function missingLine(m: MissingEmailEntry): string {
  const who = m.name ?? 'ללא שם';
  return m.apartment_number
    ? `דירה ${m.apartment_number} · ${MISSING_ROLE_LABEL[m.role]} · ${who}`
    : `${MISSING_ROLE_LABEL[m.role]} · ${who}`;
}

// "רק מי שחייב" applies to owners/tenants only — hidden entirely once the
// selection has neither (e.g. "ספקים" alone), since it would filter nothing.
function debtFilterApplies(roles: Role[]): boolean {
  return roles.includes('owners') || roles.includes('tenants');
}

// Empty → "any positive debt" (null); otherwise the typed value as a number,
// valid or not — isValidMinDebtAmount is what actually judges it.
function parsedMinDebtAmount(minDebtAmount: string): number | null {
  const trimmed = minDebtAmount.trim();
  return trimmed === '' ? null : Number(trimmed);
}

// The inline Hebrew error shown under the "מעל ₪" field — null while the
// field doesn't need judging (checkbox off) or is valid.
function minDebtAmountError(onlyWithDebt: boolean, minDebtAmount: string): string | null {
  if (!onlyWithDebt) return null;
  return isValidMinDebtAmount(parsedMinDebtAmount(minDebtAmount)) ? null : MIN_DEBT_AMOUNT_ERROR;
}

// undefined whenever the filter is off or hidden (roles no longer include
// owners/tenants) — never sent to the server in that state, even if the
// checkbox was left checked before the operator switched to suppliers-only.
// Assumes the amount already passed minDebtAmountError — canSend/the
// debounced count effect both gate on that first, so this never actually
// ships an invalid number; it's a defensive fallback to "no filter" only.
function buildDebtFilterPayload(roles: Role[], onlyWithDebt: boolean, minDebtAmount: string): BroadcastDebtFilter | undefined {
  if (!onlyWithDebt || !debtFilterApplies(roles)) return undefined;
  const amount = parsedMinDebtAmount(minDebtAmount);
  if (!isValidMinDebtAmount(amount)) return undefined;
  return { only_with_debt: true, min_debt_amount: amount };
}

// A fresh idempotency token per compose session — a double-click / retry POSTs the
// same token, so the server returns the SAME campaign instead of a duplicate.
function newToken(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `t-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
}

// Rendered both as the /broadcasts/new page (the "תפוצה" category) AND embedded
// inside the broadcast window (Sheet) opened from the Messages screen.
// `embedded` drops the page header (the window supplies its own);
// `onOpenDetail`/`onCancel` replace the route <Link>s with in-window navigation
// so the user never leaves the broadcast window. `channelLock` fixes the
// channel and hides the selector — the chat's window stays WhatsApp-only,
// exactly as it was before the email channel existed.
export function BroadcastComposeClient({
  embedded = false,
  onOpenDetail,
  onCancel,
  channelLock,
}: {
  embedded?: boolean;
  onOpenDetail?: (id: string) => void;
  onCancel?: () => void;
  channelLock?: BroadcastChannel;
} = {}) {
  const [channel, setChannel] = useState<BroadcastChannel>(channelLock ?? 'whatsapp');
  const isEmail = channel === 'email';
  const [subject, setSubject] = useState('');
  const [missing, setMissing] = useState<MissingEmailEntry[]>([]);
  const [showMissing, setShowMissing] = useState(false);
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<Role[]>(DEFAULT_ROLES);
  const [onlyWithDebt, setOnlyWithDebt] = useState(false);
  const [minDebtAmount, setMinDebtAmount] = useState('');
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [templateId, setTemplateId] = useState(FREE_TEXT);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [partialCount, setPartialCount] = useState(0);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Campaign | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const minDebtAmountErr = minDebtAmountError(onlyWithDebt, minDebtAmount);
  const tokenRef = useRef(newToken());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  // Where the variable chips insert: the subject when it was the last field
  // the operator was in (email only), otherwise the message.
  const insertTarget = useRef<'subject' | 'body'>('body');
  const subjectErr = isEmail ? emailSubjectError(subject.trim()) : null;
  // One email carries every file: on the email channel their total is 25MB.
  const attachmentsTotalErr = isEmail
    ? validateBroadcastAttachmentSet(
      attachments.filter((a) => a.status !== 'error'), [], WHATSAPP_ATTACHMENT_LIMITS.maxFiles, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES,
    )
    : null;
  // Staged uploads that never became part of a broadcast are removed when the
  // compose form goes away (window closed) — best-effort, keepalive so it
  // survives the unmount. Launched ones are already linked (DELETE → 404, harmless).
  const stagedRef = useRef<StagedAttachment[]>([]);
  useEffect(() => { stagedRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    for (const a of stagedRef.current) {
      if (a.attachmentId) {
        void fetch(`/api/whatsapp/campaigns/attachments/${a.attachmentId}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => {});
      }
    }
  }, []);

  // Load templates once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/whatsapp/templates', { credentials: 'include' });
        if (r.ok) setTemplates((await r.json()) as Tpl[]);
      } catch { /* non-fatal */ }
    })();
  }, []);

  // Live estimate of messages that will actually go out, for the CURRENT
  // role selection + content — the content decides free-form vs. debt-
  // consolidated routing server-side (isDebtMessageTemplate), so both must be
  // sent. A debt template with "ספקים" checked is blocked server-side (a
  // supplier has no apartment/debt) — the same message surfaces here so send
  // is disabled before the operator even attempts it.
  // Debounced: `content` changes on every keystroke, the count doesn't need to.
  useEffect(() => {
    let cancelled = false;
    setCount(null);
    setAudienceError(null);
    setMissing([]);
    if (roles.length === 0) return;
    // An invalid "מעל ₪" already shows its own inline error below the field —
    // no need to round-trip to the server just to get told the same thing.
    if (minDebtAmountErr) return;
    const debtFilter = buildDebtFilterPayload(roles, onlyWithDebt, minDebtAmount);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const r = await fetch('/api/whatsapp/audience-count', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              type: 'selection', roles, body: content, debt_filter: debtFilter,
              ...(channel === 'email' ? { channel, subject } : {}),
            }),
          });
          const d = (await r.json().catch(() => ({}))) as { count?: number; partial_count?: number; missing?: MissingEmailEntry[]; error?: string };
          if (cancelled) return;
          if (!r.ok || d.error) { setCount(null); setPartialCount(0); setAudienceError(d.error ?? 'שגיאה בחישוב נמענים'); return; }
          setCount(d.count ?? 0); setPartialCount(d.partial_count ?? 0); setMissing(d.missing ?? []);
        } catch { if (!cancelled) { setCount(null); setPartialCount(0); } }
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roles, content, onlyWithDebt, minDebtAmount, minDebtAmountErr, channel, subject]);

  function toggleRole(role: Role) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  function selectTemplate(value: string | null) {
    const next = value ?? FREE_TEXT;
    setTemplateId(next);
    if (next === FREE_TEXT) return;
    const tpl = templates.find((t) => t.id === next);
    if (tpl) {
      setContent(tpl.content);
      // The template's own subject fills the email subject when it has one.
      if (tpl.subject) setSubject(tpl.subject);
    }
  }

  function insertPlaceholder(token: string) {
    if (isEmail && insertTarget.current === 'subject') {
      const input = subjectRef.current;
      const start = input?.selectionStart ?? subject.length;
      const end = input?.selectionEnd ?? subject.length;
      setSubject(subject.slice(0, start) + token + subject.slice(end));
      requestAnimationFrame(() => { input?.focus(); const pos = start + token.length; input?.setSelectionRange(pos, pos); });
      return;
    }
    const el = textareaRef.current;
    if (!el) { setContent((c) => c + token); return; }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + token + content.slice(end));
    requestAnimationFrame(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); });
  }

  const uploading = isUploading(attachments);
  const canSend = name.trim().length > 0 && content.trim().length > 0 && roles.length > 0
    && !sending && !uploading && !audienceError && !minDebtAmountErr && (count ?? 0) > 0
    && (!isEmail || (subject.trim().length > 0 && !subjectErr && !attachmentsTotalErr));

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const debtFilter = buildDebtFilterPayload(roles, onlyWithDebt, minDebtAmount);
      const r = await fetch('/api/whatsapp/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          body: content.trim(),
          template_id: templateId === FREE_TEXT ? undefined : templateId,
          audience: { type: 'selection', roles, ...(debtFilter ? { debt_filter: debtFilter } : {}) },
          client_token: tokenRef.current,
          attachment_ids: readyAttachmentIds(attachments),
          ...(isEmail ? { channel, subject: subject.trim() } : {}),
        }),
      });
      const data = (await r.json().catch(() => ({}))) as Campaign & { error?: string; partial_detail_count?: number };
      if (!r.ok) throw new Error(data.error || `יצירת תפוצה נכשלה (HTTP ${r.status})`);
      const partial = data.partial_detail_count ?? 0;
      toast.success(`התפוצה יצאה לדרך — ${data.total_count} נמענים${partial > 0 ? `, ${partial} מהם עם פירוט חלקי` : ''}`);
      // The files now belong to the broadcast — nothing left to clean up.
      setAttachments([]);
      setLaunched(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'יצירת תפוצה נכשלה');
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setLaunched(null);
    setName(''); setContent(''); setTemplateId(FREE_TEXT); setRoles(DEFAULT_ROLES); setAttachments([]);
    setSubject(''); setShowMissing(false);
    setAudienceError(null);
    setOnlyWithDebt(false); setMinDebtAmount('');
    tokenRef.current = newToken();
  }

  // After launch, show ONLY the active-send status for that broadcast.
  if (launched) return <LaunchedStatus initial={launched} onReset={reset} onOpenDetail={onOpenDetail} />;

  return (
    <div className={cn('space-y-6', !embedded && 'mx-auto max-w-3xl')}>
      {/* Header — the window supplies its own, so hide it when embedded. */}
      {!embedded && (
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" render={<Link href="/broadcasts/history" />} aria-label="חזרה להיסטוריה">
            <ArrowRight className="h-5 w-5" />
          </Button>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <Megaphone className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">תפוצה חדשה</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">שליחת הודעה לקבוצת נמענים — ב-WhatsApp או במייל.</p>
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5">
        {/* Channel — hidden where it is fixed (the chat's WhatsApp window). */}
        {!channelLock && (
          <div className="space-y-1.5">
            <Label id="bc-channel-label" className="text-base font-medium text-muted-foreground">ערוץ</Label>
            <div role="radiogroup" aria-labelledby="bc-channel-label" className="flex flex-wrap gap-2">
              {CHANNELS.map((c) => {
                const active = channel === c.value;
                return (
                  <button key={c.value} type="button" role="radio" aria-checked={active} disabled={sending}
                    onClick={() => setChannel(c.value)}
                    className={cn('inline-flex h-11 items-center gap-2 rounded-full border px-5 text-sm font-semibold transition-colors',
                      active ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                    <c.icon className="h-4 w-4" /> {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Name */}
        <div className="space-y-1.5">
          <Label htmlFor="bc-name" className="text-base font-medium text-muted-foreground">שם התפוצה<span className="text-red-500">*</span></Label>
          <Input id="bc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: תזכורת תשלום דצמבר" className="h-10" disabled={sending} />
        </div>

        {/* Audience — multi-select: any combination of owners/tenants/suppliers */}
        <div className="space-y-1.5">
          <Label className="text-base font-medium text-muted-foreground">קהל יעד</Label>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((role) => {
              const active = roles.includes(role.value);
              return (
                <button key={role.value} type="button" onClick={() => toggleRole(role.value)} disabled={sending}
                  aria-pressed={active}
                  className={cn('inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors',
                    active ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                  <role.icon className="h-4 w-4" /> {role.label}
                </button>
              );
            })}
          </div>

          {/* Debt filter (Section 4) — owners/tenants only; hidden once the
              selection has neither (e.g. "ספקים" בלבד), since it would filter nothing. */}
          {debtFilterApplies(roles) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
              <div className="flex items-center gap-2">
                <Checkbox id="bc-only-debt" checked={onlyWithDebt} disabled={sending}
                  onCheckedChange={(v) => setOnlyWithDebt(v === true)} />
                <Label htmlFor="bc-only-debt" className="text-sm font-medium text-slate-700">רק מי שחייב</Label>
              </div>
              {onlyWithDebt && (
                <div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="bc-min-debt" className="text-sm text-slate-600">מעל ₪</Label>
                    <Input id="bc-min-debt" type="number" inputMode="decimal" min={0} step="1"
                      value={minDebtAmount} onChange={(e) => setMinDebtAmount(e.target.value)}
                      placeholder="0" className={cn('h-10 w-28', minDebtAmountErr && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                      disabled={sending} />
                  </div>
                  {minDebtAmountErr && (
                    <p className="mt-1 text-[12px] font-semibold text-red-500">⚠️ {minDebtAmountErr}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {roles.length === 0 ? (
            <p className="text-xs font-medium text-red-600">בחרו לפחות קהל יעד אחד.</p>
          ) : audienceError ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{audienceError}</p>
          ) : minDebtAmountErr ? null : isEmail ? (
            <>
              <p className="text-xs text-slate-500">
                {count === null ? 'מחשב נמענים…' : (
                  <>
                    נמענים עם אימייל: <span className="font-bold text-slate-700 tabular-nums">{count}</span>
                    {' · '}ללא אימייל: <span className="font-bold text-amber-700 tabular-nums">{missing.length}</span>
                  </>
                )}
              </p>
              {count !== null && missing.length > 0 && (
                <div className="space-y-1.5">
                  <button type="button" onClick={() => setShowMissing((v) => !v)} aria-expanded={showMissing}
                    className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800">
                    <ChevronDown className={cn('h-4 w-4 transition-transform', showMissing && 'rotate-180')} />
                    {showMissing ? 'הסתר' : 'הצג'} את מי שאין לו אימייל ({missing.length}) — לא יקבלו את התפוצה
                  </button>
                  {showMissing && (
                    <ul aria-label="נמענים ללא אימייל" className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
                      {missing.map((m, i) => <li key={i}>{missingLine(m)}</li>)}
                    </ul>
                  )}
                </div>
              )}
              {count !== null && partialCount > 0 && (
                <p className="text-xs font-medium text-amber-700">
                  {partialCount} {partialCount === 1 ? 'נמען יקבל' : 'נמענים יקבלו'} פירוט חלקי — רשימת הדירות ארוכה מדי להצגה מלאה.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                {count === null ? 'מחשב נמענים…' : <>נמענים עם טלפון תקין: <span className="font-bold text-slate-700 tabular-nums">{count}</span></>}
              </p>
              {count !== null && partialCount > 0 && (
                <p className="text-xs font-medium text-amber-700">
                  {partialCount} {partialCount === 1 ? 'נמען יקבל' : 'נמענים יקבלו'} פירוט חלקי — רשימת הדירות ארוכה מדי להצגה מלאה.
                </p>
              )}
            </>
          )}
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

        {/* Email subject — email only; placeholders resolve per recipient. */}
        {isEmail && (
          <div className="space-y-1.5">
            <Label htmlFor="bc-subject" className="text-base font-medium text-muted-foreground">נושא המייל<span className="text-red-500">*</span></Label>
            <Input id="bc-subject" ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)}
              onFocus={() => { insertTarget.current = 'subject'; }}
              placeholder="לדוגמה: עדכון חשוב לדיירי הבניין" disabled={sending}
              className={cn('h-10', subjectErr && 'border-red-400 bg-red-50 focus-visible:ring-red-200')} />
            {subjectErr && <p className="text-[12px] font-semibold text-red-500">⚠️ {subjectErr}</p>}
          </div>
        )}

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
            onFocus={() => { insertTarget.current = 'body'; }}
            placeholder="שלום {{name}}, נותר חוב של {{debt}} בדירה {{apartment}}..." rows={18} className="min-h-48 resize-none" disabled={sending} dir="rtl" />
          <p className="text-xs text-muted-foreground">המשתנים יוחלפו אוטומטית לכל נמען. תוכן ההודעה נשמר כפי שהוא ברגע השליחה.</p>
        </div>

        {/* Attachments — uploaded on pick, linked to the broadcast at send. On
            the email channel they ride in every email, so their total is 25MB. */}
        <div className="space-y-1.5">
          <AttachmentPicker items={attachments} onChange={setAttachments} disabled={sending}
            policy={isEmail ? EMAIL_BROADCAST_ATTACHMENT_POLICY : WHATSAPP_ATTACHMENT_POLICY} />
          {attachmentsTotalErr && <p className="text-[12px] font-semibold text-red-500">⚠️ {attachmentsTotalErr} — הסירו קבצים כדי לשלוח במייל</p>}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>ביטול</Button>
        ) : (
          <Button type="button" variant="outline" render={<Link href="/broadcasts/history" />}>ביטול</Button>
        )}
        <Button type="button" onClick={handleSend} disabled={!canSend} variant="approve" className="gap-2">
          {sending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? 'שולח…' : uploading ? 'מעלה קבצים…' : `שלח לתפוצה${count ? ` (${count})` : ''}`}
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
          <Button type="button" variant="outline" render={<Link href={`/broadcasts/history/${c.id}`} />} className="gap-2">
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
