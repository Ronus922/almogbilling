'use client';

// Shared reminders editor (Section) for the task & issue forms. Controlled: the
// parent owns the rows array (so it can do dirty-detection) and the payload
// build/load via the exported helpers. Reminders persist in the generic
// public.reminders table (entity_type/entity_id) and fire via the cron engine
// (@/lib/reminders/engine), which already handles entity_type 'task' and 'issue'.
//
// Channels are MULTI-select (migration 049): each reminder fires on any
// combination of in-system / email / WhatsApp (at least one).

import { Bell, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import { REMINDER_CHANNELS, effectiveChannels } from '@/lib/notify/channels';
import type { ReminderChannel } from '@/lib/types/tasks';

export interface ReminderRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channels: ReminderChannel[]; // at least one
}

const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  in_app: 'בתוך המערכת',
  email: 'אימייל',
  whatsapp: 'וואטסאפ',
};

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

/**
 * Build the POST/PATCH `reminders` payload from rows. Incomplete rows (no date)
 * are skipped silently. Returns null if any dated row is unparseable OR has no
 * channel selected (caller surfaces an error and aborts the save).
 */
export function buildRemindersPayload(
  rows: ReminderRow[],
): { remind_at: string; channels: ReminderChannel[] }[] | null {
  const out: { remind_at: string; channels: ReminderChannel[] }[] = [];
  for (const r of rows) {
    if (!r.date) continue;
    if (r.channels.length === 0) return null;
    const time = r.time || '09:00';
    const local = new Date(`${r.date}T${time}:00`);
    if (Number.isNaN(local.getTime())) return null;
    out.push({ remind_at: local.toISOString(), channels: r.channels });
  }
  return out;
}

interface Props {
  reminders: ReminderRow[];
  onChange: (next: ReminderRow[]) => void;
  disabled?: boolean;
  /** Render as a bare sub-block (no Card) when nested under another Section. */
  bare?: boolean;
}

export function RemindersSection({ reminders, onChange, disabled = false, bare = false }: Props) {
  function add() {
    onChange([...reminders, { date: '', time: '09:00', channels: ['in_app'] }]);
  }
  function update(idx: number, patch: Partial<ReminderRow>) {
    onChange(reminders.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    onChange(reminders.filter((_, i) => i !== idx));
  }
  function toggleChannel(idx: number, ch: ReminderChannel) {
    const row = reminders[idx];
    if (!row) return;
    const has = row.channels.includes(ch);
    let next = has ? row.channels.filter((c) => c !== ch) : [...row.channels, ch];
    if (next.length === 0) next = [ch]; // keep at least one — cannot clear the last
    update(idx, { channels: next });
  }

  return (
    <Section
      title="תזכורות"
      icon={Bell}
      iconTone="amber"
      bare={bare}
      headerSlot={
        !disabled ? (
          <button
            type="button"
            onClick={add}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200"
          >
            <Plus className="h-3.5 w-3.5" /> הוסף
          </button>
        ) : undefined
      }
    >
      <div className="space-y-3 py-2">
        {reminders.length === 0 && (
          <p className="py-2 text-center text-xs text-slate-400">אין תזכורות. הוסף תזכורת כדי לקבל התראה.</p>
        )}
        {reminders.map((r, idx) => (
          <div key={idx} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-muted-foreground">תאריך</Label>
                <Input
                  type="date"
                  value={r.date}
                  onChange={(e) => update(idx, { date: e.target.value })}
                  disabled={disabled}
                  onClick={(e) => {
                    const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                    try { el.showPicker?.(); } catch { /* native fallback */ }
                  }}
                  className="h-10 cursor-pointer"
                />
              </div>
              <div className="w-full space-y-1 sm:w-28">
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
            <div className="mt-2 space-y-1">
              <Label className="text-xs text-muted-foreground">ערוצים</Label>
              <div className="flex flex-wrap gap-1.5">
                {REMINDER_CHANNELS.map((ch) => {
                  const active = r.channels.includes(ch);
                  return (
                    <button
                      key={ch}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleChannel(idx, ch)}
                      aria-pressed={active}
                      className={cn(
                        'h-9 rounded-lg border px-3 text-xs font-semibold transition-colors',
                        active
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        disabled && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      {CHANNEL_LABEL[ch]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
