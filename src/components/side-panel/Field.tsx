'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// The standard labelled input of a side panel, per DESIGN.md §6 + §3:
// label = `text-base font-medium text-muted-foreground`, input height `h-10`
// (panel size — NOT the shadcn default), error state `border-red-400 bg-red-50`
// with a 12px red message below.
//
// Extracted from contact-form-panel.tsx, which grew its own private copy. Any
// new panel uses THIS one so the field contract cannot drift per screen.

export interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  dir?: 'ltr' | 'rtl';
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  tabularNums?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Muted helper text under the input, shown only when there is no error. */
  hint?: string;
}

export function Field({
  id, label, value, onChange, onBlur, error, required, disabled,
  type, dir, inputMode, tabularNums, placeholder, autoFocus, hint,
}: FieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
        dir={dir}
        inputMode={inputMode}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-10',
          tabularNums && 'tabular-nums',
          error && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
        )}
      />
      {error
        ? <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>
        : hint ? <p className="text-[12px] text-slate-500 text-start">{hint}</p> : null}
    </div>
  );
}
