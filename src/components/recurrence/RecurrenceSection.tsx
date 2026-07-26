'use client';

import { Repeat } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { CadenceStrip } from '@/components/recurrence/CadenceStrip';
import { cn } from '@/lib/utils';
import type { RecurrenceEndType } from '@/lib/recurrence/engine';
import { cadenceChips, cadenceLabel, HE_WEEKDAYS_SHORT } from '@/lib/recurrence/cadence';
import {
  RECURRENCE_PRESETS, RECURRENCE_END_TYPES, PRESETS_WITH_INTERVAL,
  presetToRule, recurrencePresetLabel, recurrenceEndTypeLabel,
  type CadencePreset, type RecurrenceFormState,
} from '@/lib/constants/recurrence';

export interface RecurrenceSeriesActions {
  onSkip: () => void;
  onDetach: () => void;
  onEnd: () => void;
}

interface Props {
  value: RecurrenceFormState;
  onChange: (next: RecurrenceFormState) => void;
  disabled?: boolean;
  /** Recurrence needs an anchor — the task's due date. */
  hasDueDate?: boolean;
  /** The task's due date, used to render the live cadence preview. */
  dueDate?: string | null;
  /** Present when the task already belongs to a series → renders the actions. */
  series?: RecurrenceSeriesActions | null;
}

export function RecurrenceSection({
  value, onChange, disabled, hasDueDate = true, dueDate = null, series = null,
}: Props) {
  const set = <K extends keyof RecurrenceFormState>(key: K, v: RecurrenceFormState[K]) =>
    onChange({ ...value, [key]: v });

  const toggleWeekday = (day: number) => {
    const has = value.byweekday.includes(day);
    set('byweekday', has ? value.byweekday.filter((d) => d !== day) : [...value.byweekday, day].sort((a, b) => a - b));
  };

  const { frequency, interval } = presetToRule(value.preset, value.interval);
  const showInterval = PRESETS_WITH_INTERVAL.includes(value.preset);

  return (
    <Section title="משימה מחזורית" icon={Repeat} iconTone="blue">
      <div className="space-y-4 py-2">
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3">
          <Label className="text-base font-medium text-slate-700">חזרתיות</Label>
          <Switch
            checked={value.enabled}
            onCheckedChange={(c) => set('enabled', c)}
            disabled={disabled}
          />
        </div>

        {value.enabled && (
          <div className="space-y-4 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
            {!hasDueDate && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700">
                יש להגדיר תאריך יעד — הוא משמש כתאריך הפתיחה של הסדרה.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">תדירות</Label>
                <Select
                  value={value.preset}
                  onValueChange={(v) => { if (v) set('preset', v as CadencePreset); }}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full data-[size=default]:h-10">
                    <SelectValue>{(v: string | null) => (v ? recurrencePresetLabel(v as CadencePreset) : null)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRENCE_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* "כל כמה" only applies to the day/week presets — רבעוני / חצי-שנתי /
                  שנתי ARE the interval (monthly 3 / 6 / yearly). */}
              {showInterval && (
                <div className="space-y-2">
                  <Label className="text-base font-medium text-muted-foreground">כל כמה</Label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={value.interval}
                    onChange={(e) => set('interval', Math.max(1, Number(e.target.value) || 1))}
                    disabled={disabled}
                    dir="ltr"
                    className="h-10 tabular-nums"
                  />
                </div>
              )}
            </div>

            {value.preset === 'weekly' && (
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">ימים בשבוע</Label>
                <div className="flex gap-1.5">
                  {HE_WEEKDAYS_SHORT.map((label, day) => {
                    const on = value.byweekday.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleWeekday(day)}
                        disabled={disabled}
                        aria-pressed={on}
                        className={cn(
                          'inline-flex h-11 w-11 items-center justify-center rounded-lg border text-sm font-semibold transition-colors',
                          on
                            ? 'border-blue-600 bg-blue-50 text-blue-600'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          disabled && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-base font-medium text-muted-foreground">סיום</Label>
              <Select
                value={value.endType}
                onValueChange={(v) => { if (v) set('endType', v as RecurrenceEndType); }}
                disabled={disabled}
              >
                <SelectTrigger className="w-full data-[size=default]:h-10">
                  <SelectValue>{(v: string | null) => (v ? recurrenceEndTypeLabel(v as RecurrenceEndType) : null)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_END_TYPES.map((e) => (
                    <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {value.endType === 'on_date' && (
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">עד תאריך</Label>
                <Input
                  type="date"
                  value={value.endDate}
                  onChange={(e) => set('endDate', e.target.value)}
                  disabled={disabled}
                  className="h-10 cursor-pointer"
                />
              </div>
            )}
            {value.endType === 'after_count' && (
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">מספר מופעים</Label>
                <Input
                  type="number"
                  min={1}
                  max={366}
                  value={value.endCount}
                  onChange={(e) => set('endCount', Math.max(1, Number(e.target.value) || 1))}
                  disabled={disabled}
                  dir="ltr"
                  className="h-10 tabular-nums"
                />
              </div>
            )}

            {/* Live preview — exactly the strip the card/table will render, so the
                derived days/months are visible before saving. */}
            {dueDate && (
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">כך זה יופיע על הכרטיס</Label>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <CadenceStrip
                    size="md"
                    label={cadenceLabel(frequency, interval)}
                    chips={cadenceChips({ frequency, interval, byweekday: value.byweekday }, dueDate)}
                  />
                </div>
              </div>
            )}

            <p className="text-[11px] text-blue-700">
              המשימה נשארת שורה אחת — תאריך היעד מתקדם למופע הבא בכל השלמה.
            </p>
          </div>
        )}

        {series && (
          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold text-slate-500">פעולות על הסדרה</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={series.onSkip} disabled={disabled}>
                דלג על מופע זה
              </Button>
              <Button type="button" variant="outline" onClick={series.onDetach} disabled={disabled}>
                ערוך רק את המופע הזה
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={series.onEnd}
                disabled={disabled}
                className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              >
                סיים סדרה
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
