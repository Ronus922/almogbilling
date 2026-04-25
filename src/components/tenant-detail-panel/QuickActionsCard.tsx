import type { LucideIcon } from 'lucide-react';
import { MessageSquare, MessageCircle, Mail, Lock } from 'lucide-react';
import { Section } from './Section';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ActionDef {
  key: string;
  label: string;
  icon: LucideIcon;
  iconClass: string;
}

const ACTIONS: ActionDef[] = [
  { key: 'whatsapp', label: 'ווטסאפ', icon: MessageCircle,  iconClass: 'text-green-600' },
  { key: 'email',    label: 'אימייל',  icon: Mail,           iconClass: 'text-blue-600' },
  { key: 'sms',      label: 'SMS',     icon: MessageSquare,  iconClass: 'text-slate-600' },
];

export function QuickActionsCard() {
  return (
    <Section title="פעולות מהירות" icon={MessageSquare} iconTone="emerald">
      <div className="grid grid-cols-3 gap-2 pb-1">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <Tooltip key={a.key}>
              <TooltipTrigger render={<span className="block" />}>
                <button
                  type="button"
                  disabled
                  aria-disabled
                  aria-label={a.label}
                  className="relative inline-flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-not-allowed disabled:opacity-100"
                >
                  <Icon className={cn('h-5 w-5', a.iconClass)} />
                  <span>{a.label}</span>
                  <Lock className="absolute top-1.5 end-1.5 h-3 w-3 text-slate-400 opacity-70" />
                </button>
              </TooltipTrigger>
              <TooltipContent>בקרוב — Slice 4</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </Section>
  );
}
