'use client';

// Who collected the chips — one of the people of the order (25/11/2026). One
// picker for the three places an order is marked collected: the guard's pickup
// screen (the choice is required there) and the management's two confirmations
// (the orders table and the issue window, where it is optional — pressing the
// chosen name again takes the choice back).
//
// Rows, not a select: a guard works on a phone, and a name is picked with a
// thumb. Every row is at least 48px tall.

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CollectorOption {
  /** What the server is told: a holder line id, or the orderer. */
  key: string;
  name: string;
  apartment: string;
}

export function CollectorPicker({
  people, value, onChange, disabled = false, optional = false, showApartment = false, testId = 'chip-collector',
}: {
  people: CollectorOption[];
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  /** The choice may be left empty: a second press on the chosen row clears it. */
  optional?: boolean;
  /** The order covers several apartments: say whose is whose. */
  showApartment?: boolean;
  testId?: string;
}) {
  return (
    <div role="radiogroup" aria-label="מי אסף את הצ׳יפים" className="flex flex-col gap-2">
      {people.map((p) => {
        const on = value === p.key;
        return (
          <button
            key={p.key} type="button" role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onChange(on && optional ? null : p.key)} data-testid={testId}
            className={cn(
              'flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-start transition-colors disabled:cursor-default disabled:opacity-60',
              on ? 'border-brand bg-brand/5 text-slate-900' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border-2', on ? 'border-brand bg-brand text-white' : 'border-slate-300')}>
              {on && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
            </span>
            <span className="min-w-0 flex-1 break-words text-base font-bold">{p.name}</span>
            {showApartment && (
              <span className="shrink-0 text-sm text-slate-500">דירה <span dir="ltr" className="tabular-nums">{p.apartment}</span></span>
            )}
          </button>
        );
      })}
    </div>
  );
}
