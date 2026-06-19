'use client';

import { Bell, Mail, MessageCircle, Lock, Check } from 'lucide-react';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import { channelFor, type NotifySelection } from '@/lib/notify/selection';

/** A row in the matrix — keyed by recipient key ('me' | 'user:<id>' | 'supplier:<id>'). */
export interface NotifyRecipient {
  key: string;
  /** Row label, e.g. "אליי" or "דנה לוי". */
  label: string;
  /** Bare name for the "no email / no phone" titles. */
  name: string;
  hasEmail: boolean;
  hasPhone: boolean;
}

type ChannelKey = 'email' | 'whatsapp';

const CHANNELS: {
  key: ChannelKey;
  label: string;
  icon: typeof Mail;
  missing: string;
  missingTitlePrefix: string;
}[] = [
  { key: 'email', label: 'מייל', icon: Mail, missing: 'אין מייל', missingTitlePrefix: 'אין אימייל מעודכן ל' },
  { key: 'whatsapp', label: 'וואטסאפ', icon: MessageCircle, missing: 'אין טלפון', missingTitlePrefix: 'אין טלפון מעודכן ל' },
];

function recipientHas(r: NotifyRecipient, channel: ChannelKey): boolean {
  return channel === 'email' ? r.hasEmail : r.hasPhone;
}

/** "אליי (מייל, וואטסאפ), דנה לוי (מייל)" — over the rendered recipients only. */
function summarize(recipients: NotifyRecipient[], value: NotifySelection): string[] {
  const parts: string[] = [];
  for (const r of recipients) {
    const sel = channelFor(value, r.key);
    const chans: string[] = [];
    if (sel.email && r.hasEmail) chans.push('מייל');
    if (sel.whatsapp && r.hasPhone) chans.push('וואטסאפ');
    if (chans.length > 0) parts.push(`${r.label} (${chans.join(', ')})`);
  }
  return parts;
}

export function NotifyMatrix({
  recipients,
  value,
  onChange,
  disabled,
}: {
  recipients: NotifyRecipient[];
  value: NotifySelection;
  onChange: (next: NotifySelection) => void;
  disabled?: boolean;
}) {
  function toggle(key: string, channel: ChannelKey) {
    if (disabled) return;
    const recip = recipients.find((r) => r.key === key);
    if (!recip || !recipientHas(recip, channel)) return; // cannot select an unavailable cell
    const cur = channelFor(value, key);
    onChange({ ...value, [key]: { ...cur, [channel]: !cur[channel] } });
  }

  const summary = summarize(recipients, value);
  const anySelected = summary.length > 0;

  return (
    <Section title="שליחת התראה (אופציונלי)" icon={Bell} iconTone="blue">
      <div className="space-y-3 py-2">
        <div className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center gap-x-2 gap-y-1.5">
          {/* Header row */}
          <span />
          {CHANNELS.map((c) => (
            <div
              key={c.key}
              className="flex flex-col items-center gap-0.5 text-xs font-semibold text-slate-500"
            >
              <c.icon className="h-4 w-4" />
              {c.label}
            </div>
          ))}

          {/* One row per recipient */}
          {recipients.map((r) => (
            <RecipientRow
              key={r.key}
              recipient={r}
              value={channelFor(value, r.key)}
              onToggle={(channel) => toggle(r.key, channel)}
              disabled={disabled}
            />
          ))}
        </div>

        {anySelected ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
            יישלח: {summary.join(', ')}.
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            לא נבחר כלום — לא תישלח התראה.
          </div>
        )}
      </div>
    </Section>
  );
}

function RecipientRow({
  recipient,
  value,
  onToggle,
  disabled,
}: {
  recipient: NotifyRecipient;
  value: { email: boolean; whatsapp: boolean };
  onToggle: (channel: ChannelKey) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <span className="truncate text-sm font-medium text-slate-800" title={recipient.label}>
        {recipient.label}
      </span>
      {CHANNELS.map((c) => {
        const available = recipientHas(recipient, c.key);
        const checked = available && value[c.key];
        if (!available) {
          return (
            <div
              key={c.key}
              title={`${c.missingTitlePrefix}${recipient.name}`}
              className="flex min-h-11 cursor-not-allowed flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-slate-200 bg-slate-50 text-slate-400"
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="text-[10px]">{c.missing}</span>
            </div>
          );
        }
        return (
          <button
            key={c.key}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`${c.label} ${recipient.label}`}
            disabled={disabled}
            onClick={() => onToggle(c.key)}
            className={cn(
              'flex min-h-11 items-center justify-center rounded-lg border transition-colors',
              checked
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 bg-white text-transparent hover:border-blue-400 hover:bg-blue-50',
              disabled && 'opacity-60',
            )}
          >
            <Check className="h-5 w-5" />
          </button>
        );
      })}
    </>
  );
}
