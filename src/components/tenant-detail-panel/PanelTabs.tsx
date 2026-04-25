'use client';

import { Home, FileText, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type PanelTabKey = 'details' | 'documents' | 'history';

interface TabDef {
  key: PanelTabKey;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

const TABS: TabDef[] = [
  { key: 'details',   label: 'פרטי דייר', icon: Home },
  { key: 'documents', label: 'מסמכים',     icon: FileText, disabled: true },
  { key: 'history',   label: 'היסטוריה',   icon: Clock,    disabled: true },
];

interface Props {
  active: PanelTabKey;
  onChange: (key: PanelTabKey) => void;
}

export function PanelTabs({ active, onChange }: Props) {
  return (
    <div className="flex-none border-b border-slate-200 bg-white">
      <div className="flex items-center gap-6 px-6">
        {TABS.map((t) => {
          const isActive = t.key === active;
          const Icon = t.icon;
          const button = (
            <button
              key={t.key}
              type="button"
              onClick={() => !t.disabled && onChange(t.key)}
              disabled={t.disabled}
              className={cn(
                'inline-flex items-center gap-2 py-3 text-sm font-semibold transition-colors border-b-2 -mb-px',
                isActive
                  ? 'text-blue-700 border-blue-600'
                  : t.disabled
                    ? 'text-slate-400 border-transparent cursor-not-allowed'
                    : 'text-slate-600 border-transparent hover:text-slate-900',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-4 w-4" />
              <span>{t.label}</span>
            </button>
          );
          if (t.disabled) {
            return (
              <Tooltip key={t.key}>
                <TooltipTrigger render={<span className="block" />}>{button}</TooltipTrigger>
                <TooltipContent>בקרוב</TooltipContent>
              </Tooltip>
            );
          }
          return button;
        })}
      </div>
    </div>
  );
}
