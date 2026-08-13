'use client';

import type { HTMLAttributes } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// DESIGN.md §28 entity form-field — label 12.5px/600/slate-500 (text-xs ≈ 12px,
// nearest token), mb-1.5. Shared across the supplier panels.
export const FIELD_LABEL = 'text-xs font-semibold text-slate-500';

interface SupplierFieldProps {
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
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  tabularNums?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Editable form field (label + Input + error) — DESIGN.md §28 entity form-field.
 * Reference (new.html `.fld`): h-[42px] rounded-[10px] border-[#e2e8f0] px-[13px]
 * 14px text; focus border-#2563eb + ring 3px rgba(37,99,235,.12). Pixel-exact via
 * arbitrary values (no Tailwind token is 42px/10px). Shared by CreateSupplierPanel
 * and SupplierDetailPanel's edit mode.
 */
export function SupplierField({
  id, label, value, onChange, onBlur, error, required, disabled,
  type, dir, inputMode, tabularNums, placeholder, autoFocus,
}: SupplierFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={FIELD_LABEL}>
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
        className={cn(
          'h-[42px] rounded-[10px] border-[#e2e8f0] px-[13px] text-[14px] text-[#0f172a]',
          'focus-visible:border-[#2563eb] focus-visible:ring-[3px] focus-visible:ring-[#2563eb]/[0.12]',
          tabularNums && 'tabular-nums',
          error && 'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
        )}
      />
      {error && (
        <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>
      )}
    </div>
  );
}

interface ReadonlyFieldProps {
  label: string;
  value: string | null;
  ltr?: boolean;
  /** Render the value in the accent blue (#2563eb) — used for email / website. */
  accent?: boolean;
  className?: string;
}

/**
 * Read-only value box (label + framed box) — DESIGN.md §28 readonly box.
 * Reference (view.html): min-h-[44px] rounded-[10px] border-[#e7ebf1] bg-[#f8fafc]
 * px-[13px] py-[10px] 14px/500; empty → #94a3b8 "—"; email/website value → #2563eb.
 */
export function ReadonlyField({ label, value, ltr, accent, className }: ReadonlyFieldProps) {
  const empty = value == null || value === '';
  return (
    <div className={cn('space-y-1.5', className)}>
      <span className={cn('block', FIELD_LABEL)}>{label}</span>
      <div
        dir={ltr ? 'ltr' : undefined}
        className={cn(
          'flex min-h-[44px] items-center rounded-[10px] border border-[#e7ebf1] bg-[#f8fafc] px-[13px] py-[10px] text-[14px] font-medium',
          empty ? 'text-[#94a3b8]' : accent ? 'text-[#2563eb]' : 'text-[#0f172a]',
          ltr && 'justify-end tabular-nums',
        )}
      >
        {empty ? '—' : value}
      </div>
    </div>
  );
}
