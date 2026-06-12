import type { LucideIcon } from 'lucide-react';
import { MessageSquare, MessageCircle, Mail, Lock } from 'lucide-react';
import { Section } from './Section';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  /** Open the inline WhatsApp compose view. */
  onWhatsApp: () => void;
  /** null = enabled; a string = disabled reason shown in the tooltip
   *  (no permission / no valid phone), mirroring the table row icon. */
  whatsappDisabledReason: string | null;
  /** mailto: href when the tenant has an email; null = no address → disabled. */
  emailHref: string | null;
}

export function QuickActionsCard({ onWhatsApp, whatsappDisabledReason, emailHref }: Props) {
  return (
    <Section title="פעולות מהירות" icon={MessageSquare} iconTone="emerald">
      <div className="grid grid-cols-3 gap-2 pb-1">
        <ActionTile
          icon={MessageCircle}
          iconClass="text-green-600"
          label="ווטסאפ"
          disabledReason={whatsappDisabledReason}
          onClick={onWhatsApp}
        />
        <ActionTile
          icon={Mail}
          iconClass="text-blue-600"
          label="אימייל"
          href={emailHref ?? undefined}
          disabledReason={emailHref ? null : 'אין כתובת אימייל'}
        />
        <ActionTile
          icon={MessageSquare}
          iconClass="text-slate-600"
          label="SMS"
          disabledReason="בקרוב — טרם חובר ספק SMS"
          locked
        />
      </div>
    </Section>
  );
}

const BASE =
  'relative inline-flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors';
const ENABLED = 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 cursor-pointer';
const DISABLED = 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed';

function ActionTile({
  icon: Icon, iconClass, label, disabledReason, onClick, href, locked,
}: {
  icon: LucideIcon;
  iconClass: string;
  label: string;
  disabledReason?: string | null;
  onClick?: () => void;
  href?: string;
  /** Show the lock glyph — reserved for the "coming soon" SMS action. */
  locked?: boolean;
}) {
  const isDisabled = Boolean(disabledReason);

  const inner = (
    <>
      <Icon className={cn('h-5 w-5', isDisabled ? 'text-slate-300' : iconClass)} />
      <span>{label}</span>
      {isDisabled && locked && (
        <Lock className="absolute top-1.5 end-1.5 h-3 w-3 text-slate-400 opacity-70" />
      )}
    </>
  );

  let control;
  if (isDisabled) {
    control = (
      <button type="button" disabled aria-disabled aria-label={label} className={cn(BASE, DISABLED)}>
        {inner}
      </button>
    );
  } else if (href) {
    control = (
      <a href={href} aria-label={label} className={cn(BASE, ENABLED)}>
        {inner}
      </a>
    );
  } else {
    control = (
      <button type="button" onClick={onClick} aria-label={label} className={cn(BASE, ENABLED)}>
        {inner}
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{control}</TooltipTrigger>
      <TooltipContent>{disabledReason ?? label}</TooltipContent>
    </Tooltip>
  );
}
