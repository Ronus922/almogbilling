'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  X, CalendarDays, MapPin, Repeat, Users, Bell, Plus, Trash2, Search, Palette, Trash,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import {
  ITEM_KINDS, EVENT_STATUSES, RECURRENCE_TYPES, COLOR_OPTIONS,
  itemKindLabel, eventStatusLabel, recurrenceTypeLabel,
} from '@/lib/constants/calendar';
import type {
  CalendarColorKey, CalendarEventStatus, CalendarEventWithParticipants, CalendarItemKind,
  ParticipantInput, ParticipantSource, RecurrenceEndType, RecurrenceType,
} from '@/lib/types/calendar';
import type { ReminderChannel } from '@/lib/types/tasks';

interface Owner { id: string; name: string }

interface ReminderRow { offset: ReminderOffset; channel: ReminderChannel }
type ReminderOffset = 'none' | '15m' | '1h' | '1d';

interface ParticipantRow {
  source: ParticipantSource;
  id: string;
  name: string;
  email: string | null;
}

interface SearchResult {
  users: { source: 'user'; id: string; name: string; email: string | null; hint: string | null }[];
  contacts: { source: 'contact'; id: string; name: string; email: string | null; hint: string | null }[];
}

interface Props {
  open: boolean;
  /** null → create mode; an event → edit mode; presetDate → create at that date. */
  eventId: string | null;
  presetDate: string | null;
  canEdit: boolean;
  owners: Owner[];
  currentUserId: string;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  title: string;
  item_kind: CalendarItemKind;
  event_date: string;
  is_all_day: boolean;
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  location: string;
  description: string;
  color_key: CalendarColorKey;
  status: CalendarEventStatus;
  owner_user_id: string;
}

interface RecurrenceState {
  enabled: boolean;
  type: RecurrenceType;
  interval: number;
  endType: RecurrenceEndType;
  untilDate: string;
  count: number;
}

const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  in_app: 'בתוך המערכת', email: 'אימייל', both: 'שניהם',
};
const OFFSET_LABEL: Record<ReminderOffset, string> = {
  none: 'ללא', '15m': '15 דקות לפני', '1h': 'שעה לפני', '1d': 'יום לפני',
};
const OFFSET_MS: Record<Exclude<ReminderOffset, 'none'>, number> = {
  '15m': 15 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000,
};

function emptyForm(presetDate: string | null, currentUserId: string): FormState {
  return {
    title: '',
    item_kind: 'meeting',
    event_date: presetDate ?? '',
    is_all_day: false,
    start_time: '09:00',
    end_time: '10:00',
    location: '',
    description: '',
    color_key: 'blue',
    status: 'scheduled',
    owner_user_id: currentUserId,
  };
}

const EMPTY_RECURRENCE: RecurrenceState = {
  enabled: false, type: 'weekly', interval: 1, endType: 'never', untilDate: '', count: 10,
};

function timeFromIso(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromEvent(ev: CalendarEventWithParticipants): FormState {
  return {
    title: ev.title,
    item_kind: ev.item_kind,
    event_date: ev.event_date,
    is_all_day: ev.is_all_day,
    start_time: timeFromIso(ev.start_datetime) || '09:00',
    end_time: timeFromIso(ev.end_datetime) || '10:00',
    location: ev.location ?? '',
    description: ev.description ?? '',
    color_key: (ev.color_key as CalendarColorKey) ?? 'blue',
    status: ev.status,
    owner_user_id: ev.owner_user_id ?? '',
  };
}

export function EventFormPanel({
  open, eventId, presetDate, canEdit, owners, currentUserId, onOpenChange, onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(emptyForm(presetDate, currentUserId));
  const [initial, setInitial] = useState<FormState>(emptyForm(presetDate, currentUserId));
  const [recurrence, setRecurrence] = useState<RecurrenceState>(EMPTY_RECURRENCE);
  const [participants, setParticipants] = useState<ParticipantRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loadedEvent, setLoadedEvent] = useState<CalendarEventWithParticipants | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [scopeDialog, setScopeDialog] = useState<null | 'save' | 'delete'>(null);
  const [confirmDeleteSingle, setConfirmDeleteSingle] = useState(false);

  // participant search
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEdit = !!eventId;
  const isRecurringSeries = !!loadedEvent?.recurrence_enabled || !!loadedEvent?.parent_series_id;

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/calendar/events/${id}`, { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as {
        event: CalendarEventWithParticipants;
        reminders?: { remind_at: string; channel: ReminderChannel }[];
      };
      const ev = data.event;
      setLoadedEvent(ev);
      const f = fromEvent(ev);
      setForm(f);
      setInitial(f);
      setParticipants(
        ev.participants.map((p) => ({
          source: p.participant_source,
          id: p.participant_id,
          name: p.display_name_cache ?? 'משתתף',
          email: p.email_cache,
        })),
      );
      // map reminders back to offsets relative to start
      const startMs = ev.start_datetime ? Date.parse(ev.start_datetime)
        : Date.parse(`${ev.event_date}T09:00:00`);
      const rows: ReminderRow[] = (data.reminders ?? []).map((rem) => {
        const diff = startMs - Date.parse(rem.remind_at);
        let offset: ReminderOffset = '1h';
        if (Math.abs(diff - OFFSET_MS['15m']) < 60_000) offset = '15m';
        else if (Math.abs(diff - OFFSET_MS['1h']) < 60_000) offset = '1h';
        else if (Math.abs(diff - OFFSET_MS['1d']) < 60_000) offset = '1d';
        return { offset, channel: rem.channel };
      });
      setReminders(rows);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    const f = emptyForm(presetDate, currentUserId);
    setForm(f);
    setInitial(f);
    setRecurrence(EMPTY_RECURRENCE);
    setParticipants([]);
    setReminders([]);
    setLoadedEvent(null);
    setTitleTouched(false);
    setSubmitting(false);
    setSearch('');
    setResults(null);
    setScopeDialog(null);
    setConfirmDeleteSingle(false);
    if (eventId) void loadDetail(eventId);
  }, [open, eventId, presetDate, currentUserId, loadDetail]);

  // debounced participant search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!open) return;
    searchTimer.current = setTimeout(async () => {
      const q = search.trim();
      if (q.length === 0 && results) return;
      setSearching(true);
      try {
        const r = await fetch(`/api/calendar/participants?search=${encodeURIComponent(q)}`, {
          credentials: 'include',
        });
        if (r.ok) setResults((await r.json()) as SearchResult);
      } catch { /* */ } finally { setSearching(false); }
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, open]); // eslint-disable-line react-hooks/exhaustive-deps

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const titleError = titleTouched && !form.title.trim() ? 'כותרת היא שדה חובה' : null;
  const dateError = titleTouched && !form.event_date ? 'תאריך הוא שדה חובה' : null;

  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(initial) ||
      recurrence.enabled ||
      participants.length > 0 ||
      reminders.length > 0,
    [form, initial, recurrence.enabled, participants, reminders],
  );
  const canSubmit = canEdit && !!form.title.trim() && !!form.event_date && !submitting;
  const disabled = submitting || !canEdit;

  useEscapeKey(open && !confirmCloseOpen && !scopeDialog && !confirmDeleteSingle, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty && !isEdit) setConfirmCloseOpen(true);
    else if (dirty && JSON.stringify(form) !== JSON.stringify(initial)) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }
  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  // ── participants ──
  function addParticipant(p: ParticipantRow) {
    setParticipants((prev) =>
      prev.some((x) => x.source === p.source && x.id === p.id) ? prev : [...prev, p],
    );
  }
  function removeParticipant(idx: number) {
    setParticipants((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── reminders ──
  function addReminder() {
    setReminders((prev) => [...prev, { offset: '1h', channel: 'both' }]);
  }
  function updateReminder(idx: number, patch: Partial<ReminderRow>) {
    setReminders((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeReminder(idx: number) {
    setReminders((prev) => prev.filter((_, i) => i !== idx));
  }

  /** Build the reminders payload (remind_at relative to event start). */
  function buildRemindersPayload(): { remind_at: string; channel: ReminderChannel }[] {
    const out: { remind_at: string; channel: ReminderChannel }[] = [];
    const baseTime = form.is_all_day ? '09:00' : (form.start_time || '09:00');
    const startMs = Date.parse(`${form.event_date}T${baseTime}:00`);
    if (Number.isNaN(startMs)) return out;
    for (const r of reminders) {
      if (r.offset === 'none') continue;
      const remindMs = startMs - OFFSET_MS[r.offset];
      out.push({ remind_at: new Date(remindMs).toISOString(), channel: r.channel });
    }
    return out;
  }

  function buildBodyCore(): Record<string, unknown> {
    const startIso = form.is_all_day ? null
      : (form.start_time ? new Date(`${form.event_date}T${form.start_time}:00`).toISOString() : null);
    const endIso = form.is_all_day ? null
      : (form.end_time ? new Date(`${form.event_date}T${form.end_time}:00`).toISOString() : null);
    return {
      title: form.title.trim(),
      item_kind: form.item_kind,
      event_date: form.event_date,
      is_all_day: form.is_all_day,
      start_datetime: startIso,
      end_datetime: endIso,
      location: form.location.trim() || null,
      description: form.description.trim() || null,
      color_key: form.color_key,
      status: form.status,
      owner_user_id: form.owner_user_id || null,
      participants: participants.map<ParticipantInput>((p) => ({
        participant_source: p.source,
        participant_id: p.id,
        display_name_cache: p.name,
        email_cache: p.email,
      })),
    };
  }

  async function doCreate() {
    setSubmitting(true);
    try {
      const body = buildBodyCore();
      body.reminders = buildRemindersPayload();
      if (recurrence.enabled) {
        body.recurrence = {
          type: recurrence.type,
          interval: recurrence.interval,
          endType: recurrence.endType,
          untilDate: recurrence.endType === 'until_date' ? recurrence.untilDate || null : null,
          count: recurrence.endType === 'count' ? recurrence.count : null,
        };
      }
      const r = await fetch('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; occurrenceCount?: number; capped?: boolean };
      if (!r.ok) throw new Error(translateError(data.error) ?? 'יצירת האירוע נכשלה');
      if ((data.occurrenceCount ?? 1) > 1) {
        toast.success(`נוצרה סדרה — ${data.occurrenceCount} מופעים${data.capped ? ' (נחתך לתקרה)' : ''}`);
      } else {
        toast.success('האירוע נוצר');
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function doUpdate(scope: 'single' | 'future') {
    setSubmitting(true);
    try {
      const body = buildBodyCore();
      body.scope = scope;
      if (scope === 'single') body.reminders = buildRemindersPayload();
      const r = await fetch(`/api/calendar/events/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(translateError(data.error) ?? 'עדכון האירוע נכשל');
      toast.success(scope === 'future' ? 'הסדרה עודכנה' : 'האירוע עודכן');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSave() {
    if (!canSubmit) { setTitleTouched(true); return; }
    if (!isEdit) { void doCreate(); return; }
    if (isRecurringSeries) { setScopeDialog('save'); return; }
    void doUpdate('single');
  }

  async function doDelete(scope: 'single' | 'future') {
    setSubmitting(true);
    try {
      const r = await fetch(`/api/calendar/events/${eventId}?scope=${scope}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok && r.status !== 204) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(translateError(data.error) ?? 'מחיקת האירוע נכשלה');
      }
      toast.success(scope === 'future' ? 'הסדרה נמחקה' : 'האירוע נמחק');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleDelete() {
    if (isRecurringSeries) setScopeDialog('delete');
    else setConfirmDeleteSingle(true);
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
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? 'עריכת אירוע' : 'אירוע חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit ? 'פרטי האירוע, חזרתיות, משתתפים ותזכורות.' : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button" onClick={requestClose} aria-label="סגור" disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              {/* Details */}
              <Section title="פרטי האירוע" icon={CalendarDays} iconTone="blue">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="ev-title" className="text-base font-medium text-muted-foreground">
                      כותרת<span className="text-red-500"> *</span>
                    </Label>
                    <Input
                      id="ev-title" value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      onBlur={() => setTitleTouched(true)}
                      disabled={disabled} autoFocus={!isEdit} placeholder="כותרת האירוע"
                      className={cn('h-10', titleError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                    />
                    {titleError && <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {titleError}</p>}
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">סוג</Label>
                      <Select value={form.item_kind} onValueChange={(v) => { if (v) set('item_kind', v as CalendarItemKind); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? itemKindLabel(v as CalendarItemKind) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {ITEM_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">סטטוס</Label>
                      <Select value={form.status} onValueChange={(v) => { if (v) set('status', v as CalendarEventStatus); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? eventStatusLabel(v as CalendarEventStatus) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {EVENT_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ev-date" className="text-base font-medium text-muted-foreground">
                      תאריך<span className="text-red-500"> *</span>
                    </Label>
                    <Input
                      id="ev-date" type="date" value={form.event_date}
                      onChange={(e) => set('event_date', e.target.value)}
                      disabled={disabled}
                      onClick={(e) => { const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void }; try { el.showPicker?.(); } catch { /* */ } }}
                      className={cn('h-10 cursor-pointer', dateError && 'border-red-400 bg-red-50')}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3">
                    <Label className="text-sm font-medium text-slate-700">אירוע ליום שלם</Label>
                    <Switch checked={form.is_all_day} onCheckedChange={(c) => set('is_all_day', c)} disabled={disabled} />
                  </div>

                  {!form.is_all_day && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="ev-start" className="text-base font-medium text-muted-foreground">שעת התחלה</Label>
                        <Input id="ev-start" type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} disabled={disabled} dir="ltr" className="h-10 cursor-pointer tabular-nums" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="ev-end" className="text-base font-medium text-muted-foreground">שעת סיום</Label>
                        <Input id="ev-end" type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} disabled={disabled} dir="ltr" className="h-10 cursor-pointer tabular-nums" />
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="ev-loc" className="text-base font-medium text-muted-foreground">מיקום</Label>
                    <div className="relative">
                      <MapPin className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input id="ev-loc" value={form.location} onChange={(e) => set('location', e.target.value)} disabled={disabled} placeholder="היכן מתקיים?" className="h-10 pe-9" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ev-desc" className="text-base font-medium text-muted-foreground">תיאור</Label>
                    <Textarea id="ev-desc" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={disabled} className="min-h-20" placeholder="פירוט נוסף (אופציונלי)" />
                  </div>

                  {/* Color */}
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-base font-medium text-muted-foreground">
                      <Palette className="h-4 w-4" /> צבע
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      {COLOR_OPTIONS.map((c) => (
                        <button
                          key={c.key} type="button" disabled={disabled}
                          onClick={() => set('color_key', c.key)}
                          aria-label={c.label}
                          className={cn(
                            'h-9 w-9 rounded-full transition-transform', c.dot,
                            form.color_key === c.key ? 'ring-2 ring-slate-900 ring-offset-2 scale-105' : 'hover:scale-105',
                          )}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Owner */}
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">בעלים</Label>
                    <Select value={form.owner_user_id || '__none__'} onValueChange={(v) => { if (v) set('owner_user_id', v === '__none__' ? '' : v); }} disabled={disabled}>
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue>{(v: string | null) => { if (!v || v === '__none__') return 'ללא'; return owners.find((o) => o.id === v)?.name ?? 'משתמש'; }}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">ללא</SelectItem>
                        {owners.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Section>

              {/* Recurrence — create mode only (edit-series uses scope dialogs) */}
              {!isEdit && (
                <Section title="חזרתיות" icon={Repeat} iconTone="violet">
                  <div className="space-y-4 py-2">
                    <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3">
                      <Label className="text-sm font-medium text-slate-700">אירוע חוזר</Label>
                      <Switch checked={recurrence.enabled} onCheckedChange={(c) => setRecurrence((p) => ({ ...p, enabled: c }))} disabled={disabled} />
                    </div>
                    {recurrence.enabled && (
                      <div className="space-y-4 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-muted-foreground">תדירות</Label>
                            <Select value={recurrence.type} onValueChange={(v) => { if (v) setRecurrence((p) => ({ ...p, type: v as RecurrenceType })); }} disabled={disabled}>
                              <SelectTrigger className="w-full data-[size=default]:h-10">
                                <SelectValue>{(v: string | null) => (v ? recurrenceTypeLabel(v as RecurrenceType) : null)}</SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {RECURRENCE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-muted-foreground">כל</Label>
                            <Input type="number" min={1} max={365} value={recurrence.interval} onChange={(e) => setRecurrence((p) => ({ ...p, interval: Math.max(1, Number(e.target.value) || 1) }))} disabled={disabled} dir="ltr" className="h-10 tabular-nums" />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-muted-foreground">מסתיים</Label>
                          <Select value={recurrence.endType} onValueChange={(v) => { if (v) setRecurrence((p) => ({ ...p, endType: v as RecurrenceEndType })); }} disabled={disabled}>
                            <SelectTrigger className="w-full data-[size=default]:h-10">
                              <SelectValue>{(v: string | null) => { const m: Record<string, string> = { never: 'לעולם לא', until_date: 'בתאריך', count: 'אחרי מספר מופעים' }; return v ? m[v] : null; }}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="never">לעולם לא</SelectItem>
                              <SelectItem value="until_date">בתאריך</SelectItem>
                              <SelectItem value="count">אחרי מספר מופעים</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {recurrence.endType === 'until_date' && (
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-muted-foreground">עד תאריך</Label>
                            <Input type="date" value={recurrence.untilDate} onChange={(e) => setRecurrence((p) => ({ ...p, untilDate: e.target.value }))} disabled={disabled} className="h-10 cursor-pointer" />
                          </div>
                        )}
                        {recurrence.endType === 'count' && (
                          <div className="space-y-2">
                            <Label className="text-sm font-medium text-muted-foreground">מספר מופעים</Label>
                            <Input type="number" min={1} max={78} value={recurrence.count} onChange={(e) => setRecurrence((p) => ({ ...p, count: Math.max(1, Number(e.target.value) || 1) }))} disabled={disabled} dir="ltr" className="h-10 tabular-nums" />
                          </div>
                        )}
                        <p className="text-[11px] text-violet-700">עד 78 מופעים או 18 חודשים קדימה, הנמוך מביניהם.</p>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Participants */}
              <Section title="משתתפים" icon={Users} iconTone="emerald">
                <div className="space-y-3 py-2">
                  {!disabled && (
                    <div className="relative">
                      <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="חיפוש משתמש או איש קשר…" className="h-10 pe-9" />
                    </div>
                  )}
                  {!disabled && results && (search.trim() || (results.users.length > 0)) && (
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1">
                      {searching && <p className="px-2 py-1 text-xs text-slate-400">מחפש…</p>}
                      {[...results.users, ...results.contacts].map((o) => (
                        <button
                          key={o.source + o.id} type="button"
                          onClick={() => addParticipant({ source: o.source, id: o.id, name: o.name, email: o.email })}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-slate-50"
                        >
                          <span className={cn('inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold',
                            o.source === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700')}>
                            {o.source === 'user' ? 'מ' : 'ק'}
                          </span>
                          <span className="flex-1 truncate text-slate-800">{o.name}</span>
                          {o.hint && <span className="shrink-0 text-[11px] text-slate-400">{o.hint}</span>}
                        </button>
                      ))}
                      {!searching && results.users.length === 0 && results.contacts.length === 0 && (
                        <p className="px-2 py-1 text-xs text-slate-400">לא נמצאו תוצאות.</p>
                      )}
                    </div>
                  )}
                  {participants.length === 0 ? (
                    <p className="py-2 text-center text-xs text-slate-400">לא נבחרו משתתפים.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {participants.map((p, idx) => (
                        <div key={p.source + p.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                          <span className={cn('inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold',
                            p.source === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700')}>
                            {p.source === 'user' ? 'מ' : 'ק'}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-slate-800">{p.name}</div>
                            {p.email && <div dir="ltr" className="truncate text-[11px] text-slate-400">{p.email}</div>}
                          </div>
                          {!disabled && (
                            <button type="button" onClick={() => removeParticipant(idx)} aria-label="הסר משתתף" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Section>

              {/* Reminders */}
              <Section
                title="תזכורות" icon={Bell} iconTone="amber"
                headerSlot={!disabled ? (
                  <button type="button" onClick={addReminder} className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200">
                    <Plus className="h-3.5 w-3.5" /> הוסף
                  </button>
                ) : undefined}
              >
                <div className="space-y-3 py-2">
                  {reminders.length === 0 && <p className="py-2 text-center text-xs text-slate-400">אין תזכורות.</p>}
                  {reminders.map((r, idx) => (
                    <div key={idx} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-end">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">מתי</Label>
                        <Select value={r.offset} onValueChange={(v) => { if (v) updateReminder(idx, { offset: v as ReminderOffset }); }} disabled={disabled}>
                          <SelectTrigger className="w-full data-[size=default]:h-10">
                            <SelectValue>{(v: string | null) => (v ? OFFSET_LABEL[v as ReminderOffset] : null)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="15m">{OFFSET_LABEL['15m']}</SelectItem>
                            <SelectItem value="1h">{OFFSET_LABEL['1h']}</SelectItem>
                            <SelectItem value="1d">{OFFSET_LABEL['1d']}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="w-full space-y-1 sm:w-40">
                        <Label className="text-xs text-muted-foreground">ערוץ</Label>
                        <Select value={r.channel} onValueChange={(v) => { if (v) updateReminder(idx, { channel: v as ReminderChannel }); }} disabled={disabled}>
                          <SelectTrigger className="w-full data-[size=default]:h-10">
                            <SelectValue>{(v: string | null) => (v ? CHANNEL_LABEL[v as ReminderChannel] : null)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="in_app">{CHANNEL_LABEL.in_app}</SelectItem>
                            <SelectItem value="email">{CHANNEL_LABEL.email}</SelectItem>
                            <SelectItem value="both">{CHANNEL_LABEL.both}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {!disabled && (
                        <button type="button" onClick={() => removeReminder(idx)} aria-label="הסר תזכורת" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  {isEdit && isRecurringSeries && reminders.length > 0 && (
                    <p className="text-[11px] text-slate-400">תזכורות חלות על הסדרה (מעוגנות למופע הראשי).</p>
                  )}
                </div>
              </Section>

              {/* Delete (edit mode) */}
              {isEdit && canEdit && (
                <div className="flex justify-start">
                  <Button type="button" variant="outline" onClick={handleDelete} disabled={submitting} className="gap-2 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                    <Trash className="h-4 w-4" /> מחק אירוע
                  </Button>
                </div>
              )}
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={handleSave}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה — כניסה כצופה' : undefined}
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור אירוע'}
          />
        </SheetContent>
      </Sheet>

      {/* Discard-changes confirm */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardClose} className="bg-destructive text-white hover:bg-destructive/90">צא ללא שמירה</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single-event delete confirm */}
      <AlertDialog open={confirmDeleteSingle} onOpenChange={setConfirmDeleteSingle}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את האירוע?</AlertDialogTitle>
            <AlertDialogDescription>הפעולה אינה הפיכה.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmDeleteSingle(false); void doDelete('single'); }} className="bg-destructive text-white hover:bg-destructive/90">מחק</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Series scope dialog (edit OR delete) — Dialog is allowed here per spec */}
      <Dialog open={scopeDialog !== null} onOpenChange={(o) => { if (!o) setScopeDialog(null); }}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{scopeDialog === 'delete' ? 'מחיקת אירוע חוזר' : 'עריכת אירוע חוזר'}</DialogTitle>
            <DialogDescription>
              {scopeDialog === 'delete'
                ? 'האירוע הוא חלק מסדרה. מה ברצונך למחוק?'
                : 'האירוע הוא חלק מסדרה. על אילו מופעים להחיל את השינוי?'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              type="button" variant="outline" className="justify-start"
              onClick={() => { const action = scopeDialog; setScopeDialog(null); if (action === 'delete') void doDelete('single'); else void doUpdate('single'); }}
            >
              מופע זה בלבד
            </Button>
            <Button
              type="button"
              className={cn('justify-start', scopeDialog === 'delete' ? 'bg-destructive text-white hover:bg-destructive/90' : 'bg-blue-600 text-white hover:bg-blue-700')}
              onClick={() => { const action = scopeDialog; setScopeDialog(null); if (action === 'delete') void doDelete('future'); else void doUpdate('future'); }}
            >
              כל הסדרה מכאן והלאה
            </Button>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setScopeDialog(null)}>ביטול</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function translateError(code?: string): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    title_required: 'כותרת היא שדה חובה',
    invalid_event_date: 'תאריך לא תקין',
    end_before_start: 'שעת הסיום לפני ההתחלה',
    range_too_large: 'טווח גדול מדי',
    invalid_recurrence_until_date: 'תאריך סיום חזרתיות לא תקין',
    invalid_recurrence_count: 'מספר מופעים לא תקין',
  };
  return map[code] ?? null;
}
