'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Phone, MessageSquareText, MessageCircle, Mail, Users, Archive,
  ArchiveRestore, FileWarning, Scale, Settings2, StickyNote, MessageSquare,
  Tag, CheckCircle2, Loader2,
  Check, CheckCheck, X as XIcon, Clock, Paperclip, Image as ImageIcon,
  ExternalLink, ArrowDownLeft, ArrowUpRight, ChevronDown, type LucideIcon,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import {
  EVENT_TYPE_META, MANUAL_EVENT_TYPES, SYSTEM_EVENT_TYPES,
  type DebtorEventType,
} from '@/lib/debtor-events';
import type { DebtorHistoryEntry, HistorySource } from '@/lib/db/debtorHistory';
import type { ChatMessage, ChatStatus } from '@/types/whatsapp';

interface Props {
  debtorId: string;
  canEdit: boolean;
  /** Apartment's contact name — shown on WhatsApp rows as the related tenant. */
  tenantName?: string | null;
  /** Bump to refetch after a WhatsApp message is sent from the same panel. */
  reloadKey?: number;
  /** Called after a manual documentation entry is saved (panel marks dirty + refreshes). */
  onLogged?: () => void;
}

// lucide icon-name (from EVENT_TYPE_META) → component.
const ICONS: Record<string, LucideIcon> = {
  Phone, MessageSquareText, MessageCircle, Mail, Users, Archive,
  ArchiveRestore, FileWarning, Scale, Settings2, StickyNote, MessageSquare, Tag, CheckCircle2,
};

// tone (from EVENT_TYPE_META / SOURCE_META) → dot colours.
const TONE: Record<string, string> = {
  blue:    'bg-blue-100 text-blue-600',
  cyan:    'bg-cyan-100 text-cyan-600',
  emerald: 'bg-emerald-100 text-emerald-600',
  violet:  'bg-violet-100 text-violet-600',
  amber:   'bg-amber-100 text-amber-700',
  red:     'bg-red-100 text-red-600',
  slate:   'bg-slate-100 text-slate-600',
};

// Non-event sources get their own icon + tone.
const SOURCE_META: Record<Exclude<HistorySource, 'event'>, { icon: string; tone: string }> = {
  comment: { icon: 'MessageSquare', tone: 'blue' },
  status:  { icon: 'Tag',           tone: 'violet' },
  action:  { icon: 'CheckCircle2',  tone: 'emerald' },
};

const STATUS_SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'ידני', IMPORT: 'ייבוא', AUTO_DEFAULT: 'אוטומטי', SYSTEM_FIX: 'תיקון מערכת',
};

const SYSTEM_SET = new Set<string>(SYSTEM_EVENT_TYPES);

// A WhatsApp send auto-logs a WHATSAPP debtor_event *and* a chat_messages row
// (see whatsapp-send.ts). The event carries the message's external_message_id;
// we render the richer chat_messages row instead and drop the duplicate event.
// Manual WhatsApp docs (no external_message_id) stay on the timeline.
function isAutoWhatsappEvent(e: DebtorHistoryEntry): boolean {
  return e.source === 'event'
    && e.event_type === 'WHATSAPP'
    && Boolean(e.metadata?.external_message_id);
}

// One chronological stream: debtor history entries + WhatsApp messages.
type MergedItem =
  | { kind: 'entry';    id: string; created_at: string; entry: DebtorHistoryEntry }
  | { kind: 'whatsapp'; id: string; created_at: string; msg: ChatMessage };

type FilterKey = 'all' | 'whatsapp' | 'comments' | 'statuses' | 'docs' | 'actions' | 'system';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',      label: 'הכל' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'comments', label: 'הערות' },
  { key: 'statuses', label: 'סטטוסים' },
  { key: 'docs',     label: 'תיעוד שיחות' },
  { key: 'actions',  label: 'פעולות' },
  { key: 'system',   label: 'מערכת' },
];

function matchesFilter(item: MergedItem, key: FilterKey): boolean {
  if (key === 'all') return true;
  if (key === 'whatsapp') return item.kind === 'whatsapp';
  if (item.kind !== 'entry') return false;
  const entry = item.entry;
  switch (key) {
    case 'comments': return entry.source === 'comment';
    case 'statuses': return entry.source === 'status';
    case 'actions':  return entry.source === 'action';
    case 'docs':     return entry.source === 'event' && !SYSTEM_SET.has(entry.event_type ?? '');
    case 'system':   return entry.source === 'event' && SYSTEM_SET.has(entry.event_type ?? '');
    default:         return false;
  }
}

function visualFor(entry: DebtorHistoryEntry): { Icon: LucideIcon; toneClass: string } {
  if (entry.source === 'event' && entry.event_type && EVENT_TYPE_META[entry.event_type]) {
    const m = EVENT_TYPE_META[entry.event_type];
    return { Icon: ICONS[m.icon] ?? StickyNote, toneClass: TONE[m.tone] ?? TONE.slate };
  }
  const s = SOURCE_META[entry.source as Exclude<HistorySource, 'event'>];
  return { Icon: ICONS[s.icon] ?? StickyNote, toneClass: TONE[s.tone] ?? TONE.slate };
}

function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd/MM/yyyy HH:mm');
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : formatDistanceToNow(d, { addSuffix: true, locale: he });
}

export function HistoryTimeline({ debtorId, canEdit, tenantName, reloadKey = 0, onLogged }: Props) {
  const [entries, setEntries] = useState<DebtorHistoryEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [histRes, msgRes] = await Promise.all([
        fetch(`/api/debtors/${debtorId}/history`, { credentials: 'include' }),
        fetch(`/api/whatsapp/messages?debtor_id=${encodeURIComponent(debtorId)}`, { credentials: 'include' }),
      ]);
      if (!histRes.ok) throw new Error(`HTTP ${histRes.status}`);
      if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
      const [hist, msgs] = await Promise.all([
        histRes.json() as Promise<DebtorHistoryEntry[]>,
        msgRes.json() as Promise<ChatMessage[]>,
      ]);
      setEntries(hist);
      setMessages(msgs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  }, [debtorId]);

  useEffect(() => { load(); }, [load, reloadKey]);

  // TODO: history is capped at 100 rows server-side (HISTORY_LIMIT_DEFAULT); messages
  // aren't, so on a debtor with >100 events the two lists interleave only within the
  // loaded window. Fine for a debtor card — raise the server limit if it ever bites.
  const merged = useMemo<MergedItem[]>(() => {
    const out: MergedItem[] = [];
    for (const e of entries) {
      if (isAutoWhatsappEvent(e)) continue;
      out.push({ kind: 'entry', id: `${e.source}-${e.id}`, created_at: e.created_at, entry: e });
    }
    for (const m of messages) {
      out.push({ kind: 'whatsapp', id: `wa-${m.id}`, created_at: m.created_at, msg: m });
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return out;
  }, [entries, messages]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, whatsapp: 0, comments: 0, statuses: 0, docs: 0, actions: 0, system: 0 };
    for (const it of merged) {
      for (const f of FILTERS) if (matchesFilter(it, f.key)) c[f.key] += 1;
    }
    return c;
  }, [merged]);

  const filtered = useMemo(
    () => merged.filter((it) => matchesFilter(it, filter)),
    [merged, filter],
  );

  return (
    <div className="space-y-4">
      {/* Header — title + log-call action */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold text-slate-900">היסטוריה ותיעוד</h3>
        <LogCallButton canEdit={canEdit} onClick={() => setDialogOpen(true)} />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const n = counts[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                active
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50',
              )}
            >
              {f.label}
              {n > 0 && (
                <span className={cn(
                  'inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold',
                  active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500',
                )}>
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Timeline card */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        {loading ? (
          <TimelineSkeleton />
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            שגיאה בטעינת ההיסטוריה: {error}
          </div>
        ) : merged.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">אין עדיין היסטוריה לדייר זה.</p>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {filter === 'whatsapp' ? 'לא נמצאה היסטוריית WhatsApp לדירה זו' : 'אין רשומות בקטגוריה זו.'}
          </p>
        ) : (
          <ol className="relative space-y-5">
            {/* vertical rail aligned to the dot centre (dot = h-8/w-8 → centre ≈ 15px) */}
            <div className="pointer-events-none absolute top-1 bottom-1 start-[15px] w-px bg-slate-200" />
            {filtered.map((item) =>
              item.kind === 'whatsapp'
                ? <WhatsAppTimelineRow key={item.id} msg={item.msg} tenantName={tenantName ?? null} />
                : <TimelineRow key={item.id} entry={item.entry} />,
            )}
          </ol>
        )}
      </div>

      <LogCallDialog
        open={dialogOpen}
        debtorId={debtorId}
        onOpenChange={setDialogOpen}
        onSaved={() => { load(); onLogged?.(); }}
      />
    </div>
  );
}

function TimelineRow({ entry }: { entry: DebtorHistoryEntry }) {
  const { Icon, toneClass } = visualFor(entry);
  const statusSource = entry.source === 'status'
    ? STATUS_SOURCE_LABEL[String(entry.metadata?.source ?? '')] ?? null
    : null;

  return (
    <li className="relative flex items-start gap-3">
      <span className={cn(
        'relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-white',
        toneClass,
      )}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-slate-900">{entry.title}</span>
          {statusSource && (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
              {statusSource}
            </span>
          )}
        </div>

        {entry.description && (
          <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap break-words">
            {entry.description}
          </p>
        )}

        {entry.outcome && (
          <span className="mt-1.5 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            תוצאה: {entry.outcome}
          </span>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-400">
          {entry.actor_name && (
            <>
              <span className="font-medium text-slate-500">{entry.actor_name}</span>
              <span>•</span>
            </>
          )}
          <span dir="ltr" className="tabular-nums">{fullDate(entry.created_at)}</span>
          <span>•</span>
          <span>{relativeTime(entry.created_at)}</span>
        </div>
      </div>
    </li>
  );
}

// ─── WhatsApp timeline row ───────────────────────────────────────────────

const WA_STATUS_META: Record<ChatStatus, { label: string; cls: string; icon: LucideIcon }> = {
  sent:      { label: 'נשלח',  cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: Check },
  delivered: { label: 'נמסר',  cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: CheckCheck },
  read:      { label: 'נקרא',  cls: 'bg-sky-50 text-sky-700 ring-sky-200',             icon: CheckCheck },
  failed:    { label: 'נכשל',  cls: 'bg-red-50 text-red-700 ring-red-200',             icon: XIcon },
  pending:   { label: 'ממתין', cls: 'bg-slate-100 text-slate-600 ring-slate-200',      icon: Clock },
  queued:    { label: 'בתור',  cls: 'bg-slate-100 text-slate-600 ring-slate-200',      icon: Clock },
};

function WaStatusBadge({ status }: { status: ChatStatus }) {
  const m = WA_STATUS_META[status];
  const Icon = m.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', m.cls)}>
      <Icon className="h-3 w-3" />
      {m.label}
    </span>
  );
}

const WA_EXPAND_THRESHOLD = 180;

function WhatsAppTimelineRow({ msg, tenantName }: { msg: ChatMessage; tenantName: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const inbound = msg.direction === 'received';
  const isFile = msg.message_type === 'image' || msg.message_type === 'document';
  const fileUrl = msg.media_url || msg.content || '';
  const body = msg.content ?? '';
  const longText = !isFile && body.length > WA_EXPAND_THRESHOLD;

  const sender = inbound ? (tenantName || msg.contact_phone) : (msg.sent_by_name || 'מערכת');
  const recipient = inbound ? 'המשרד' : (tenantName || msg.contact_phone);

  return (
    <li className="relative flex items-start gap-3">
      <span className={cn(
        'relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-white',
        inbound ? 'bg-sky-100 text-sky-600' : 'bg-emerald-100 text-emerald-600',
      )}>
        <MessageCircle className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-slate-900">וואטסאפ</span>
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1',
            inbound ? 'bg-sky-50 text-sky-700 ring-sky-200' : 'bg-emerald-50 text-emerald-700 ring-emerald-200',
          )}>
            {inbound ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
            {inbound ? 'התקבלה' : 'נשלחה'}
          </span>
          {!inbound && <WaStatusBadge status={msg.status} />}
        </div>

        <div className="mt-1 text-sm text-slate-700">
          {isFile ? (
            fileUrl ? (
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-emerald-700 hover:underline"
              >
                {msg.message_type === 'image' ? <ImageIcon className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
                {msg.message_type === 'image' ? 'תמונה' : 'קובץ מצורף'}
                <ExternalLink className="h-3 w-3 opacity-70" />
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-slate-500">
                <Paperclip className="h-4 w-4" />
                {msg.message_type === 'image' ? 'תמונה' : 'קובץ מצורף'}
              </span>
            )
          ) : body ? (
            <p className={cn('whitespace-pre-wrap break-words', !expanded && longText && 'line-clamp-3')}>
              {body}
            </p>
          ) : (
            <span className="text-slate-400">—</span>
          )}
          {longText && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
              {expanded ? 'הצג פחות' : 'הצג עוד'}
            </button>
          )}
        </div>

        {!inbound && msg.status === 'failed' && msg.error_detail && (
          <p className="mt-1 truncate text-[11px] text-red-500" title={msg.error_detail}>
            {msg.error_detail}
          </p>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-400">
          <span className="font-medium text-slate-500">{sender}</span>
          <span aria-hidden>←</span>
          <span className="text-slate-500">{recipient}</span>
          <span>•</span>
          <span dir="ltr" className="tabular-nums">{fullDate(msg.created_at)}</span>
          <span>•</span>
          <span>{relativeTime(msg.created_at)}</span>
        </div>
      </div>
    </li>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="h-8 w-8 shrink-0 rounded-full bg-muted animate-pulse" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-4 w-40 rounded bg-muted animate-pulse" />
            <div className="h-3 w-56 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function LogCallButton({ canEdit, onClick }: { canEdit: boolean; onClick: () => void }) {
  if (!canEdit) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <Button type="button" disabled className="gap-2">
            <Phone className="h-4 w-4" /> תיעוד שיחה
          </Button>
        </TooltipTrigger>
        <TooltipContent>אין הרשאה</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button type="button" onClick={onClick} className="gap-2">
      <Phone className="h-4 w-4" /> תיעוד שיחה
    </Button>
  );
}

function LogCallDialog({
  open, debtorId, onOpenChange, onSaved,
}: {
  open: boolean;
  debtorId: string;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [channel, setChannel] = useState<DebtorEventType>('PHONE_CALL');
  const [summary, setSummary] = useState('');
  const [outcome, setOutcome] = useState('');
  const [saving, setSaving] = useState(false);

  useEscapeKey(open && !saving, () => onOpenChange(false));

  // Reset fields whenever the dialog (re)opens.
  useEffect(() => {
    if (open) { setChannel('PHONE_CALL'); setSummary(''); setOutcome(''); }
  }, [open]);

  const canSave = summary.trim().length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/debtors/${debtorId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          event_type: channel,
          description: summary.trim(),
          outcome: outcome.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('התיעוד נשמר');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(`שמירה נכשלה: ${err instanceof Error ? err.message : 'שגיאה'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>תיעוד שיחה</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="log-channel" className="text-sm font-medium text-muted-foreground">ערוץ</Label>
            <Select value={channel} onValueChange={(v) => { if (v) setChannel(v as DebtorEventType); }}>
              <SelectTrigger id="log-channel" className="w-full data-[size=default]:h-10">
                <SelectValue placeholder="בחר ערוץ">
                  {(value) => (value ? EVENT_TYPE_META[value as DebtorEventType]?.label : 'בחר ערוץ')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MANUAL_EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{EVENT_TYPE_META[t].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="log-summary" className="text-sm font-medium text-muted-foreground">סיכום השיחה</Label>
            <Textarea
              id="log-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="מה נאמר בשיחה?"
              rows={4}
              className="resize-none"
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="log-outcome" className="text-sm font-medium text-muted-foreground">תוצאה / סיכום קצר (אופציונלי)</Label>
            <Input
              id="log-outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="לדוגמה: הבטיח לשלם עד סוף החודש"
              className="h-10"
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            ביטול
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="gap-2"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
            {saving ? 'שומר…' : 'שמור תיעוד'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
