'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Megaphone, Send, Loader2, Home, UserCheck, Truck, ArrowRight, Eye, CheckCircle2, OctagonX,
  AlertTriangle, ChevronDown,
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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/whatsapp-template';
import { isValidMinDebtAmount, MIN_DEBT_AMOUNT_ERROR } from '@/lib/whatsapp-audience-filter';
import type { Campaign } from '@/lib/wa-queue/types';
import type { BroadcastDebtFilter, WhatsAppTemplate as Tpl } from '@/types/whatsapp';
import { CampaignStatusBadge } from '../_components/StatusBadge';
import { StopBroadcastDialog } from '../_components/StopBroadcastDialog';
import {
  AttachmentPicker, readyAttachmentIds, isUploading, type StagedAttachment,
} from '@/components/whatsapp/AttachmentPicker';
import { useStopBroadcast } from '../_lib/useStopBroadcast';
import { usePoll } from '../_lib/usePoll';
import { isTerminal, isCancellable, progressPct, processed } from '../_lib/status';

const FREE_TEXT = '__free__';
type Role = 'owners' | 'tenants' | 'suppliers';
const ROLES: { value: Role; label: string; icon: typeof Home }[] = [
  { value: 'owners', label: 'בעלי נכסים', icon: Home },
  { value: 'tenants', label: 'שוכרים', icon: UserCheck },
  { value: 'suppliers', label: 'ספקים', icon: Truck },
];
const DEFAULT_ROLES: Role[] = ['owners', 'tenants'];

// Section 7 — POST /api/whatsapp/campaigns/preview's response shape.
interface PreviewRecipientRow {
  kind: 'resident' | 'supplier';
  name: string;
  apartmentNumber: string | null;
  extraApartmentCount: number;
  phoneMasked: string;
  truncated: boolean;
  message: string;
}
interface PreviewRejectedRow {
  role: 'owner' | 'tenant' | 'supplier';
  name: string | null;
  apartmentNumber: string | null;
  phoneMasked: string | null;
  reason: 'unparseable' | 'landline';
}
interface PreviewData {
  count: number;
  partial_detail_count: number;
  invalid_phone_count: number;
  recipients: PreviewRecipientRow[];
  rejected: PreviewRejectedRow[];
}
const REJECTED_REASON_LABEL: Record<PreviewRejectedRow['reason'], string> = {
  unparseable: 'מספר לא תקין',
  landline: 'טלפון קווי (לא נייד)',
};

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
  const [roles, setRoles] = useState<Role[]>(DEFAULT_ROLES);
  const [onlyWithDebt, setOnlyWithDebt] = useState(false);
  const [minDebtAmount, setMinDebtAmount] = useState('');
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [templateId, setTemplateId] = useState(FREE_TEXT);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [partialCount, setPartialCount] = useState(0);
  const [invalidPhoneCount, setInvalidPhoneCount] = useState(0);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [launched, setLaunched] = useState<Campaign | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const minDebtAmountErr = minDebtAmountError(onlyWithDebt, minDebtAmount);
  const tokenRef = useRef(newToken());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    setInvalidPhoneCount(0);
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
            body: JSON.stringify({ type: 'selection', roles, body: content, debt_filter: debtFilter }),
          });
          const d = (await r.json().catch(() => ({}))) as { count?: number; partial_count?: number; invalid_phone_count?: number; error?: string };
          if (cancelled) return;
          if (!r.ok || d.error) { setCount(null); setPartialCount(0); setInvalidPhoneCount(0); setAudienceError(d.error ?? 'שגיאה בחישוב נמענים'); return; }
          setCount(d.count ?? 0); setPartialCount(d.partial_count ?? 0); setInvalidPhoneCount(d.invalid_phone_count ?? 0);
        } catch { if (!cancelled) { setCount(null); setPartialCount(0); setInvalidPhoneCount(0); } }
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roles, content, onlyWithDebt, minDebtAmount, minDebtAmountErr]);

  function toggleRole(role: Role) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

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

  const uploading = isUploading(attachments);
  const canSend = name.trim().length > 0 && content.trim().length > 0 && roles.length > 0
    && !sending && !uploading && !audienceError && !minDebtAmountErr && (count ?? 0) > 0;

  // Section 7 — the button no longer sends directly: it resolves the exact
  // recipient list (same resolvers, same rendering) WITHOUT creating anything,
  // so the operator can review who gets what before the real send. A
  // dedicated read-only endpoint (POST /api/whatsapp/campaigns/preview) —
  // never the campaign-creation route itself, which stays untouched.
  async function openPreview() {
    if (!canSend) return;
    setPreviewLoading(true);
    try {
      const debtFilter = buildDebtFilterPayload(roles, onlyWithDebt, minDebtAmount);
      const r = await fetch('/api/whatsapp/campaigns/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ roles, body: content.trim(), debt_filter: debtFilter }),
      });
      const data = (await r.json().catch(() => ({}))) as PreviewData & { error?: string };
      if (!r.ok) throw new Error(data.error || `תצוגה מקדימה נכשלה (HTTP ${r.status})`);
      setPreview(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'תצוגה מקדימה נכשלה');
    } finally {
      setPreviewLoading(false);
    }
  }

  // The actual send — unchanged from before Section 7, just triggered from the
  // preview step's confirm button instead of directly from the compose form.
  async function confirmSend() {
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
        }),
      });
      const data = (await r.json().catch(() => ({}))) as Campaign & { error?: string; partial_detail_count?: number; invalid_phone_count?: number };
      if (!r.ok) throw new Error(data.error || `יצירת תפוצה נכשלה (HTTP ${r.status})`);
      const partial = data.partial_detail_count ?? 0;
      const invalidPhones = data.invalid_phone_count ?? 0;
      toast.success(`התפוצה יצאה לדרך — ${data.total_count} נמענים${partial > 0 ? `, ${partial} מהם עם פירוט חלקי` : ''}${invalidPhones > 0 ? `. ${invalidPhones} נוספים לא נכללו — מספר טלפון לא תקין` : ''}`);
      // The files now belong to the broadcast — nothing left to clean up.
      setAttachments([]);
      setPreview(null);
      setLaunched(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'יצירת תפוצה נכשלה');
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setLaunched(null);
    setPreview(null);
    setName(''); setContent(''); setTemplateId(FREE_TEXT); setRoles(DEFAULT_ROLES); setAttachments([]);
    setAudienceError(null);
    setOnlyWithDebt(false); setMinDebtAmount(''); setInvalidPhoneCount(0);
    tokenRef.current = newToken();
  }

  // After launch, show ONLY the active-send status for that broadcast.
  if (launched) return <LaunchedStatus initial={launched} onReset={reset} onOpenDetail={onOpenDetail} />;
  // Before launch, a resolved preview replaces the compose form until the
  // operator confirms (or goes back to keep editing).
  if (preview) {
    return (
      <PreviewStep data={preview} name={name.trim()} sending={sending}
        onBack={() => setPreview(null)} onConfirm={() => void confirmSend()} />
    );
  }

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
          ) : minDebtAmountErr ? null : (
            <>
              <p className="text-xs text-slate-500">
                {count === null ? 'מחשב נמענים…' : <>נמענים עם טלפון תקין: <span className="font-bold text-slate-700 tabular-nums">{count}</span></>}
              </p>
              {count !== null && partialCount > 0 && (
                <p className="text-xs font-medium text-amber-700">
                  {partialCount} {partialCount === 1 ? 'נמען יקבל' : 'נמענים יקבלו'} פירוט חלקי — רשימת הדירות ארוכה מדי להצגה מלאה.
                </p>
              )}
              {/* Section 6 — report-only: never filters `count`, just flags data
                  quality (unparseable number / landline) before the operator sends. */}
              {count !== null && invalidPhoneCount > 0 && (
                <p className="text-xs font-medium text-amber-700">
                  ⚠️ {invalidPhoneCount} {invalidPhoneCount === 1 ? 'נמען נוסף לא יקבל' : 'נמענים נוספים לא יקבלו'} הודעה — מספר הטלפון שלהם לא תקין (חסר/שגוי) או קווי (לא נייד).
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

        {/* Attachments — uploaded on pick, linked to the broadcast at send. */}
        <AttachmentPicker items={attachments} onChange={setAttachments} disabled={sending} />
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>ביטול</Button>
        ) : (
          <Button type="button" variant="outline" render={<Link href="/whatsapp/broadcasts" />}>ביטול</Button>
        )}
        <Button type="button" onClick={() => void openPreview()} disabled={!canSend || previewLoading} variant="approve" className="gap-2">
          {previewLoading || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          {previewLoading ? 'טוען תצוגה מקדימה…' : uploading ? 'מעלה קבצים…' : `תצוגה מקדימה${count ? ` (${count})` : ''}`}
        </Button>
      </div>
    </div>
  );
}

// Section 7 — the recipient preview shown between "תצוגה מקדימה" and the
// actual send. Read-only review of exactly what POST /api/whatsapp/campaigns
// preview resolved: nothing here can be edited (no per-recipient exclusion —
// out of scope; "back" returns to the compose form to change the audience/
// content instead). Mirrors the campaign detail page's RecipientLog styling
// (mobile card list + desktop table) for a consistent recipient-list look.
function PreviewStep({
  data, name, sending, onBack, onConfirm,
}: {
  data: PreviewData;
  name: string;
  sending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [rejectedOpen, setRejectedOpen] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} disabled={sending} aria-label="חזרה לעריכה">
          <ArrowRight className="h-5 w-5" />
        </Button>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
          <Eye className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-slate-900">תצוגה מקדימה</h1>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{name || 'תפוצה חדשה'} — בדקו לפני שליחה, אי אפשר לבטל אחרי.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="נמענים" value={data.count} tone="text-slate-700" />
        <Stat label="פירוט חלקי" value={data.partial_detail_count} tone="text-amber-700" />
        <Stat label="לא יקבלו (טלפון)" value={data.invalid_phone_count} tone="text-red-600" />
      </div>

      {data.rejected.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <button type="button" onClick={() => setRejectedOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 text-start text-sm font-semibold text-red-700">
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {data.rejected.length} לא יקבלו הודעה — מספר טלפון לא תקין</span>
            <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', rejectedOpen && 'rotate-180')} />
          </button>
          {rejectedOpen && (
            <ul className="mt-2 space-y-1.5 border-t border-red-200 pt-2">
              {data.rejected.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-red-800">
                  <span className="font-semibold">{r.name ?? '—'}{r.apartmentNumber ? ` · דירה ${r.apartmentNumber}` : ''}</span>
                  <span className="flex items-center gap-2 text-red-600">
                    {r.phoneMasked && <span dir="ltr" className="tabular-nums">{r.phoneMasked}</span>}
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold">{REJECTED_REASON_LABEL[r.reason]}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="max-h-[420px] overflow-y-auto">
          {/* מובייל (<md) — כרטיס לכל נמען. */}
          <ul className="space-y-2 p-3 roomy:hidden">
            {data.recipients.map((r, i) => (
              <li key={i} className="rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs">
                <button type="button" onClick={() => setExpanded((e) => (e === i ? null : i))} className="w-full text-start">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-slate-800">{r.name}</span>
                    {r.truncated && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">פירוט חלקי</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-slate-600">
                    <span dir="ltr" className="tabular-nums">{r.phoneMasked}</span>
                    {r.kind === 'supplier' ? <span>ספק</span> : r.apartmentNumber && (
                      <span>דירה {r.apartmentNumber}{r.extraApartmentCount > 0 ? ` (+${r.extraApartmentCount} נוספות)` : ''}</span>
                    )}
                  </div>
                </button>
                {expanded === i && <p className="mt-2 whitespace-pre-wrap border-t border-slate-100 pt-2 text-[13px] text-slate-700">{r.message}</p>}
              </li>
            ))}
          </ul>

          <Table className="hidden roomy:table">
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                {['נמען', 'טלפון', 'דירה', ''].map((h, i) => (
                  <TableHead key={h || 'expand'} className={cn('h-11 px-3 text-sm font-semibold text-slate-500', i === 3 ? 'w-10' : 'text-start')}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recipients.map((r, i) => (
                <Fragment key={i}>
                  <TableRow className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setExpanded((e) => (e === i ? null : i))}>
                    <TableCell className="px-3 py-3 text-start text-sm font-semibold text-slate-800 max-w-[220px] truncate">
                      {r.name} {r.truncated && <span className="ms-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">פירוט חלקי</span>}
                    </TableCell>
                    <TableCell className="px-3 py-3 text-start text-sm text-slate-600 tabular-nums"><span dir="ltr">{r.phoneMasked}</span></TableCell>
                    <TableCell className="px-3 py-3 text-start text-sm text-slate-600">
                      {r.kind === 'supplier' ? 'ספק' : (r.apartmentNumber ?? '—')}{r.extraApartmentCount > 0 ? ` (+${r.extraApartmentCount})` : ''}
                    </TableCell>
                    <TableCell className="px-3 py-3 text-center">
                      <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', expanded === i && 'rotate-180')} />
                    </TableCell>
                  </TableRow>
                  {expanded === i && (
                    <TableRow className="border-b border-slate-100 bg-slate-50">
                      <TableCell colSpan={4} className="px-3 py-3 text-start text-sm whitespace-pre-wrap text-slate-700">{r.message}</TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={sending}>חזרה לעריכה</Button>
        <Button type="button" onClick={onConfirm} disabled={sending} variant="approve" className="gap-2">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? 'שולח…' : `אישור ושליחה (${data.count})`}
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
