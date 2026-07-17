'use client';

// Global channel picker (ref: NewProblem "ערוץ שליחה") — replaces the
// recipient×channel matrix. Two cards (WhatsApp / email); the chosen channel(s)
// are sent to the SELECTED handlers only (expanded via channelsToSelection at
// submit). No recipient list, no "אליי". Shared by the issue & task forms.

import { useEffect } from 'react';
import { Mail, MessageCircle, Bell, Check, User } from 'lucide-react';
import { Section, SectionHint } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import type { ChannelValue } from '@/lib/notify/selection';

const CARDS: { key: keyof ChannelValue; label: string; sub: string; missing: string; icon: typeof Mail }[] = [
  { key: 'whatsapp', label: 'וואטסאפ', sub: 'שליחה מיידית לנייד', missing: 'אין נמען עם טלפון', icon: MessageCircle },
  { key: 'email', label: 'מייל', sub: 'שליחה לתיבת הדוא״ל', missing: 'אין נמען עם מייל', icon: Mail },
];

export function ChannelCards({
  value,
  onChange,
  disabled,
  bare = false,
  /** At least one handler (assignee) is selected — governs the footer hint. */
  hasHandler,
  /** "אליי" self opt-in — the current user also receives the notification. */
  self,
  onSelfChange,
  emailAvailable,
  phoneAvailable,
  selfEnabled,
}: {
  value: ChannelValue;
  onChange: (v: ChannelValue) => void;
  disabled?: boolean;
  bare?: boolean;
  hasHandler: boolean;
  self: boolean;
  onSelfChange: (v: boolean) => void;
  /** True when at least one selected recipient (handler / self) has an email. */
  emailAvailable: boolean;
  /** True when at least one selected recipient (handler / self) has a phone. */
  phoneAvailable: boolean;
  /** "אליי" is a reminder option — allowed only once a dated reminder exists. */
  selfEnabled: boolean;
}) {
  const avail: Record<keyof ChannelValue, boolean> = { email: emailAvailable, whatsapp: phoneAvailable };

  // A channel can't stay selected once no recipient can receive it (handler
  // removed / self turned off). Clear it so an undeliverable channel is never
  // submitted — the button also disables below (server re-checks regardless).
  useEffect(() => {
    if ((value.email && !emailAvailable) || (value.whatsapp && !phoneAvailable)) {
      onChange({ email: value.email && emailAvailable, whatsapp: value.whatsapp && phoneAvailable });
    }
  }, [emailAvailable, phoneAvailable, value.email, value.whatsapp, onChange]);

  // "אליי" only applies to reminders — drop it if the last reminder is removed.
  useEffect(() => {
    if (self && !selfEnabled) onSelfChange(false);
  }, [self, selfEnabled, onSelfChange]);

  const anyChannel = value.whatsapp || value.email;
  const chosen = [value.email && 'מייל', value.whatsapp && 'וואטסאפ'].filter(Boolean).join(', ');
  // The channel cards drive the IMMEDIATE send — to the handler only. ("אליי" is
  // a reminder recipient, handled via the reminders + notify_owner path.)
  const willSend = anyChannel && hasHandler;

  return (
    <Section
      title="שליחת התראה"
      icon={Bell}
      iconTone="blue"
      bare={bare}
      headerSlot={<SectionHint>אופציונלי</SectionHint>}
    >
      <div className="space-y-3 py-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {CARDS.map((c) => {
            const available = avail[c.key];
            const checked = value[c.key] && available;
            const cardDisabled = disabled || !available;
            return (
              <button
                key={c.key}
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={c.label}
                disabled={cardDisabled}
                title={!available ? c.missing : undefined}
                onClick={() => onChange({ ...value, [c.key]: !checked })}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-start transition-colors',
                  checked ? 'border-blue-600 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50',
                  cardDisabled && 'cursor-not-allowed opacity-60 hover:bg-white',
                )}
              >
                {/* RTL start: icon + label + sub (or "no recipient" hint) */}
                <span className="flex min-w-0 items-center gap-3">
                  <span className={cn(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                    checked ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400',
                  )}>
                    <c.icon className="h-4 w-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold text-slate-800">{c.label}</span>
                    <span className={cn('truncate text-xs', available ? 'text-slate-500' : 'text-amber-600')}>
                      {available ? c.sub : c.missing}
                    </span>
                  </span>
                </span>
                {/* RTL end: checkbox */}
                <span className={cn(
                  'grid h-5 w-5 shrink-0 place-items-center rounded border',
                  checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white',
                )}>
                  {checked && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            );
          })}

          {/* Third cell — "אליי": a REMINDER option, enabled only once a dated
              reminder exists. When on, the reminder(s) also go to the current user. */}
          <button
            type="button"
            role="checkbox"
            aria-checked={self && selfEnabled}
            aria-label="שלח גם אליי"
            disabled={disabled || !selfEnabled}
            title={!selfEnabled ? 'הוסף תזכורת עם מועד כדי לאפשר' : undefined}
            onClick={() => onSelfChange(!self)}
            className={cn(
              'flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-start transition-colors',
              self && selfEnabled ? 'border-blue-600 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50',
              (disabled || !selfEnabled) && 'cursor-not-allowed opacity-60 hover:bg-white',
            )}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                self && selfEnabled ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400',
              )}>
                <User className="h-4 w-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold text-slate-800">שלח גם אליי</span>
                <span className={cn('truncate text-xs', selfEnabled ? 'text-slate-500' : 'text-amber-600')}>
                  {selfEnabled ? 'התזכורות גם אליך' : 'דורש תזכורת עם מועד'}
                </span>
              </span>
            </span>
            <span className={cn(
              'grid h-5 w-5 shrink-0 place-items-center rounded border',
              self && selfEnabled ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white',
            )}>
              {self && selfEnabled && <Check className="h-3.5 w-3.5" />}
            </span>
          </button>
        </div>

        <div className={cn(
          'rounded-lg border px-3 py-2 text-sm',
          willSend
            ? 'border-emerald-200 bg-emerald-50 font-medium text-emerald-700'
            : 'border-slate-200 bg-slate-50 text-slate-500',
        )}>
          {willSend
            ? `יישלח לגורם המטפל: ${chosen}.`
            : anyChannel
              ? 'בחרו גורם מטפל כדי לשלוח בערוצים אלה.'
              : 'לא נבחר כלום — לא תישלח התראה מיידית.'}
        </div>
      </div>
    </Section>
  );
}
