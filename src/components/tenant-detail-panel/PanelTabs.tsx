'use client';

import { Home, FileText, Clock, KeyRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type PanelTabKey = 'details' | 'documents' | 'history' | 'chips';

interface TabDef {
  key: PanelTabKey;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

const TABS: TabDef[] = [
  { key: 'details',   label: 'פרטי דייר', icon: Home },
  { key: 'documents', label: 'מסמכים',     icon: FileText },
  { key: 'history',   label: 'היסטוריה',   icon: Clock },
  { key: 'chips',     label: 'צ׳יפים',     icon: KeyRound },
];

interface Props {
  active: PanelTabKey;
  onChange: (key: PanelTabKey) => void;
  /** Tabs to drop entirely (e.g. 'chips' without chips:view). Default: none. */
  hiddenTabs?: PanelTabKey[];
}

export function PanelTabs({ active, onChange, hiddenTabs = [] }: Props) {
  return (
    <div className="flex-none border-b border-slate-200 bg-white">
      <div className="flex items-center gap-6 px-6">
        {TABS.filter((t) => !hiddenTabs.includes(t.key)).map((t) => {
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
