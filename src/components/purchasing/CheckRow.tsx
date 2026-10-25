'use client';

import { Checkbox } from '@/components/ui/checkbox';

/** A bordered, fully clickable checkbox row. The row is a div (not a label): a
 *  <label> around Base UI's checkbox lets one click toggle it twice. */
export function CheckRow({
  checked, onToggle, disabled, name, children, className,
}: { checked: boolean; onToggle: () => void; disabled?: boolean; name: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest('[data-slot="checkbox"], input[type="checkbox"]')) return;
        onToggle();
      }}
      className={`flex min-h-11 items-center gap-3 rounded-lg border border-line bg-white px-3 py-2 ${disabled ? '' : 'cursor-pointer'} ${className ?? ''}`}
    >
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => onToggle()} aria-label={name} />
      {children}
    </div>
  );
}
