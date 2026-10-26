'use client';

import type { ReactNode } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { LegalStatus } from '@/types/tenant';

/** The colour dot + name of a legal status, as every status picker shows it. */
export function LegalStatusOption({ status }: { status: Pick<LegalStatus, 'name' | 'color'> }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-slate-900/10"
        style={{ backgroundColor: status.color }}
      />
      {status.name}
    </span>
  );
}

interface Props {
  statuses: LegalStatus[];
  value: string | null | undefined;
  onValueChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Extra classes for the trigger (height, width). */
  className?: string;
  /** Where the list opens; `top` for a control that sits at the screen bottom. */
  side?: 'top' | 'bottom';
}

/**
 * Legal-status dropdown (DESIGN §6 Select): the items hold JSX, so SelectValue
 * takes the children-function that renders the chosen status — without it the
 * trigger would show the raw id. Shared by the debtor panel and the bulk bar.
 */
export function LegalStatusSelect({
  statuses, value, onValueChange, disabled, placeholder = 'בחר סטטוס...', className, side,
}: Props) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={cn('w-full data-[size=default]:h-10', className)}>
        <SelectValue placeholder={placeholder}>
          {(id: string | null) => {
            // A children-function replaces the placeholder, so it renders it itself.
            if (!id) return <span className="text-muted-foreground">{placeholder}</span>;
            const s = statuses.find((x) => x.id === id);
            return s ? <LegalStatusOption status={s} /> : id;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent side={side} alignItemWithTrigger={side ? false : undefined}>
        {statuses.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <LegalStatusOption status={s} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
