'use client';

// Shared reminders editor (Section) for the task & issue forms. Controlled: the
// parent owns the rows array (so it can do dirty-detection) and the payload
// build/load via the exported helpers. Reminders persist in the generic
// public.reminders table (entity_type/entity_id) and fire via the cron engine
// (@/lib/reminders/engine), which already handles entity_type 'task' and 'issue'.
//
// Channel choice is now GLOBAL (the form's channel cards), not per-reminder:
// every scheduled reminder inherits the channels selected there (falling back to
// in_app when none). So this component edits only WHEN (date+time); the caller
// passes the derived channels into buildRemindersPayload at submit.

import { Bell, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import { effectiveChannels } from '@/lib/notify/channels';
import type { ReminderChannel } from '@/lib/types/tasks';
import type { ChannelValue } from '@/lib/notify/selection';

export interface ReminderRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channels: ReminderChannel[]; // legacy field — ignored at submit (global channels win)
}

/** Map a server reminder's ISO remind_at into the {date,time} a row needs. */
export function splitRemindAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Normalize a server reminder's stored channels into a non-empty row set
 *  (handles legacy rows that only carry the single `channel`). */
export function rowChannels(
  channels: ReminderChannel[] | null | undefined,
  legacyChannel?: string | null,
): ReminderChannel[] {
  return effectiveChannels(channels, legacyChannel);
}

/** Derive the reminder channels from the global channel cards: the selected
 *  channels (email/whatsapp), or in_app alone when nothing is selected. */
export function channelsFromGlobals(c: ChannelValue): ReminderChannel[] {
  const out: ReminderChannel[] = [];
  if (c.email) out.push('email');
  if (c.whatsapp) out.push('whatsapp');
  return out.length > 0 ? out : ['in_app'];
}

/**
 * Build the POST/PATCH `reminders` payload from rows. Incomplete rows (no date)
 * are skipped silently. Every reminder fires on `channels` (the global choice)
 * and carries `notify_owner` (the "אליי" self opt-in — same for all rows).
 * Returns null if any dated row is unparseable (caller surfaces an error).
 */
export function buildRemindersPayload(
  rows: ReminderRow[],
  channels: ReminderChannel[],
  notifyOwner: boolean,
): { remind_at: string; channels: ReminderChannel[]; notify_owner: boolean }[] | null {
  const out: { remind_at: string; channels: ReminderChannel[]; notify_owner: boolean }[] = [];
  for (const r of rows) {
    if (!r.date) continue;
    const time = r.time || '09:00';
    const local = new Date(`${r.date}T${time}:00`);
    if (Number.isNaN(local.getTime())) return null;
    out.push({ remind_at: local.toISOString(), channels, notify_owner: notifyOwner });
  }
  return out;
}

/** True when a NEW dated reminder is in the past (browser-local). Rows that were
 *  loaded unchanged (present in `initial`) are exempt — editing an old record that
 *  is already past must not be blocked, only creating a fresh past reminder. */
export function hasNewPastReminder(rows: ReminderRow[], initial: ReminderRow[]): boolean {
  const loaded = new Set(initial.map((r) => `${r.date}T${r.time}`));
  const cutoff = Date.now() - 60_000; // 1-min grace for submit latency / clock skew
  for (const r of rows) {
    if (!r.date || loaded.has(`${r.date}T${r.time}`)) continue;
    const t = new Date(`${r.date}T${r.time || '09:00'}:00`).getTime();
    if (!Number.isNaN(t) && t < cutoff) return true;
  }
  return false;
}

// Client-side date helpers (browser-local tz = the user's tz, e.g. Asia/Jerusalem).
function pad(n: number): string { return String(n).padStart(2, '0'); }
function localDateISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** "now" rounded UP to the next 5-minute mark — the default for a new reminder. */
function nowRoundedUp5(): { date: string; time: string } {
  const d = new Date();
  d.setSeconds(0, 0);
  const add = (5 - (d.getMinutes() % 5)) % 5;
  if (add) d.setMinutes(d.getMinutes() + add);
  return { date: localDateISO(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

interface Props {
  reminders: ReminderRow[];
  onChange: (next: ReminderRow[]) => void;
  disabled?: boolean;
  /** Render as a bare sub-block (no Card) when nested under another Section. */
  bare?: boolean;
}

export function RemindersSection({ reminders, onChange, disabled = false, bare = false }: Props) {
  // Past dates can't be picked for a new/edited reminder (loaded old rows keep theirs).
  const todayISO = localDateISO(new Date());

  // New rows carry an empty channels[] — the global choice is applied at submit.
  function addRow(date: string, time: string) {
    onChange([...reminders, { date, time, channels: [] }]);
  }
  function update(idx: number, patch: Partial<ReminderRow>) {
    onChange(reminders.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    onChange(reminders.filter((_, i) => i !== idx));
  }

  return (
    <Section
      title="תזמון תזכורות"
      icon={Bell}
      iconTone="amber"
      bare={bare}
      headerSlot={
        !disabled ? (
          <button
            type="button"
            onClick={() => { const n = nowRoundedUp5(); addRow(n.date, n.time); }}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" /> הוסף תזכורת
          </button>
        ) : undefined
      }
    >
      <div className="space-y-3 py-2">
        {reminders.length === 0 && (
          <p className="py-2 text-center text-xs text-slate-400">אין תזכורות. הוסף תזכורת כדי לקבל התראה.</p>
        )}
        {reminders.map((r, idx) => (
          <div key={idx} className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">תאריך</Label>
              <Input
                type="date"
                value={r.date}
                min={todayISO}
                onChange={(e) => update(idx, { date: e.target.value })}
                disabled={disabled}
                onClick={(e) => {
                  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                  try { el.showPicker?.(); } catch { /* native fallback */ }
                }}
                className="h-10 cursor-pointer"
              />
            </div>
            <div className="w-28 space-y-1">
              <Label className="text-xs text-muted-foreground">שעה</Label>
              <Input
                type="time"
                value={r.time}
                onChange={(e) => update(idx, { time: e.target.value })}
                disabled={disabled}
                dir="ltr"
                className="h-10 cursor-pointer tabular-nums"
              />
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label="הסר תזכורת"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
