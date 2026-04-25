'use client';

import { Check, Pipette } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PALETTE } from '../data/palette';
import { COLOR_HEX_RE } from '@/lib/validation/status';

export function ColorPicker({
  value,
  onChange,
  previewName,
  error,
}: {
  value: string;
  onChange: (hex: string) => void;
  previewName: string;
  error?: string | null;
}) {
  const isValid = COLOR_HEX_RE.test(value);
  const previewBg = isValid ? value : '#e5e7eb';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-base font-medium text-muted-foreground">צבע</Label>
        <span
          className="inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold text-slate-900"
          style={{ backgroundColor: previewBg }}
        >
          {previewName.trim() || 'תצוגה מקדימה'}
        </span>
      </div>

      <div className="grid grid-cols-6 gap-2">
        {PALETTE.map((c) => {
          const selected = c.hex.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={c.hex}
              type="button"
              onClick={() => onChange(c.hex)}
              aria-label={c.label}
              aria-pressed={selected}
              className={cn(
                'relative h-9 rounded-lg ring-1 ring-slate-200 transition-shadow hover:ring-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                selected && 'ring-2 ring-blue-600 ring-offset-1',
              )}
              style={{ backgroundColor: c.hex }}
            >
              {selected && (
                <Check className="absolute inset-0 m-auto h-4 w-4 text-slate-900" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Pipette className="h-4 w-4 text-slate-400" />
        <Input
          dir="ltr"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#3B82F6"
          className={cn(
            'h-9 font-mono text-sm tabular-nums',
            error && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
          )}
          maxLength={7}
        />
      </div>

      {error && (
        <p className="text-[12px] font-semibold text-red-500">⚠️ {error}</p>
      )}
    </div>
  );
}
