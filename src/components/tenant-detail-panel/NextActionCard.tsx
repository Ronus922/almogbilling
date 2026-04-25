'use client';

import { Calendar, AlertTriangle } from 'lucide-react';
import { Section } from './Section';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isPastDate } from '@/lib/validation';

export interface NextActionDraft {
  description: string;
  date: string;
}

interface Props {
  value: NextActionDraft;
  onChange: (v: NextActionDraft) => void;
  disabled?: boolean;
}

export function NextActionCard({ value, onChange, disabled }: Props) {
  const pastWarning = value.date && isPastDate(value.date);

  return (
    <Section title="פעולה הבאה לביצוע" icon={Calendar} iconTone="amber">
      <div className="space-y-3 pb-1">
        <div className="space-y-1.5">
          <Label htmlFor="next-action-desc" className="text-base font-medium text-muted-foreground">
            תיאור פעולה
          </Label>
          <Input
            id="next-action-desc"
            value={value.description}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            placeholder="הכנס תיאור פעולה..."
            disabled={disabled}
            className="h-10"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next-action-date" className="text-base font-medium text-muted-foreground">
            תאריך יעד לפעולה
          </Label>
          <Input
            id="next-action-date"
            type="date"
            value={value.date}
            onChange={(e) => onChange({ ...value, date: e.target.value })}
            onClick={(e) => {
              const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
              try { el.showPicker?.(); } catch { /* unsupported — fallback to native click-on-icon */ }
            }}
            disabled={disabled}
            className="h-10 cursor-pointer [&::-webkit-calendar-picker-indicator]:ms-0 [&::-webkit-calendar-picker-indicator]:me-auto [&::-webkit-calendar-picker-indicator]:cursor-pointer"
          />
          {pastWarning && (
            <p className="text-xs text-amber-600 inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              תאריך היעד עבר
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
