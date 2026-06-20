'use client';

// Shared reminders editor (Section) for the task & issue forms. Controlled: the
// parent owns the rows array (so it can do dirty-detection) and the payload
// build/load via the exported helpers. Reminders persist in the generic
// public.reminders table (entity_type/entity_id) and fire via the cron engine
// (@/lib/reminders/engine), which already handles entity_type 'task' and 'issue'.

import { Bell, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Section } from '@/components/side-panel/Section';
import type { ReminderChannel } from '@/lib/types/tasks';

export interface ReminderRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channel: ReminderChannel;
}

const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  in_app: 'בתוך המערכת',
  email: 'אימייל',
  both: 'שניהם',
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

/**
 * Build the POST/PATCH `reminders` payload from rows. Incomplete rows (no date)
 * are skipped silently. Returns null if any row's date+time is unparseable
 * (caller surfaces an error and aborts the save).
 */
export function buildRemindersPayload(
  rows: ReminderRow[],
): { remind_at: string; channel: ReminderChannel }[] | null {
  const out: { remind_at: string; channel: ReminderChannel }[] = [];
  for (const r of rows) {
    if (!r.date) continue;
    const time = r.time || '09:00';
    const local = new Date(`${r.date}T${time}:00`);
    if (Number.isNaN(local.getTime())) return null;
    out.push({ remind_at: local.toISOString(), channel: r.channel });
  }
  return out;
}

interface Props {
  reminders: ReminderRow[];
  onChange: (next: ReminderRow[]) => void;
  disabled?: boolean;
}

export function RemindersSection({ reminders, onChange, disabled = false }: Props) {
  function add() {
    onChange([...reminders, { date: '', time: '09:00', channel: 'both' }]);
  }
  function update(idx: number, patch: Partial<ReminderRow>) {
    onChange(reminders.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function remove(idx: number) {
    onChange(reminders.filter((_, i) => i !== idx));
  }

  return (
    <Section
      title="תזכורות"
      icon={Bell}
      iconTone="amber"
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
          <div key={idx} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-end">
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
            <div className="w-full space-y-1 sm:w-36">
              <Label className="text-xs text-muted-foreground">ערוץ</Label>
              <Select value={r.channel} onValueChange={(v) => { if (v) update(idx, { channel: v as ReminderChannel }); }} disabled={disabled}>
                <SelectTrigger className="w-full data-[size=default]:h-10">
                  <SelectValue>{(v: string | null) => (v ? CHANNEL_LABEL[v as ReminderChannel] : null)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_app">{CHANNEL_LABEL.in_app}</SelectItem>
                  <SelectItem value="email">{CHANNEL_LABEL.email}</SelectItem>
                  <SelectItem value="both">{CHANNEL_LABEL.both}</SelectItem>
                  <SelectItem value="whatsapp">{CHANNEL_LABEL.whatsapp}</SelectItem>
                </SelectContent>
              </Select>
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
