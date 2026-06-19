'use client';

// Shared read-only renderer for a task/issue target (יעד) in tables + kanban.
// Icon by type (דירה → Home, איזור → MapPin) + the resolved label
// (`target_label` from the list query). "—" when there is no target.

import { Home, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TargetType } from '@/lib/types/targets';

interface Props {
  type: TargetType | null;
  label: string | null;
  /** 'md' (tables) | 'sm' (kanban meta row). */
  size?: 'sm' | 'md';
  className?: string;
}

export function TargetCell({ type, label, size = 'md', className }: Props) {
  if (!type || !label) {
    return <span className="text-slate-400">—</span>;
  }
  const Icon = type === 'room' ? Home : MapPin;
  const text = type === 'room' ? `דירה ${label}` : label;
  const sm = size === 'sm';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-slate-600',
        sm ? 'text-[11px] text-slate-400' : 'text-sm',
        className,
      )}
      title={text}
    >
      <Icon className={cn('shrink-0 text-slate-400', sm ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
      <span className={sm ? undefined : 'truncate'}>{text}</span>
    </span>
  );
}
