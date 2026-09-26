'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FinMonthStatus } from '@/lib/types/finance';

// "מוצג לדיירים / מוסתר מדיירים" — the publish switch of ONE month, next to
// the period picker when a single month is selected. Saved at once (PUT
// /api/finance/month-status), optimistic, rolled back on failure.
export function PublishToggle({ month, status: initial, canEdit, onChange }: {
  /** 'YYYY-MM' */
  month: string;
  status: FinMonthStatus;
  canEdit: boolean;
  onChange?: (status: FinMonthStatus) => void;
}) {
  const [status, setStatus] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    const before = status;
    setStatus((s) => ({ ...s, published: next }));
    setSaving(true);
    try {
      const r = await fetch('/api/finance/month-status', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ month, published: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { status?: FinMonthStatus; error?: string };
      if (!r.ok || !data.status) throw new Error(data.error ?? 'שמירה נכשלה');
      setStatus(data.status);
      onChange?.(data.status);
      toast.success(next ? 'החודש מוצג לדיירים' : 'החודש מוסתר מדיירים');
    } catch (err) {
      setStatus(before);
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const pill = (
    <span
      className={cn(
        'inline-flex h-[38px] items-center gap-1.5 rounded-[10px] border px-3 text-sm font-semibold',
        status.published ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600',
      )}
    >
      {status.published ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
      {status.published ? 'מוצג לדיירים' : 'מוסתר מדיירים'}
    </span>
  );

  if (!canEdit) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>
        <label className="flex h-11 cursor-pointer select-none items-center gap-2 px-1">
          <Switch checked={status.published} onCheckedChange={(v) => void toggle(v)} disabled={saving} aria-label="הצג חודש לדיירים" />
          {pill}
        </label>
      </TooltipTrigger>
      <TooltipContent>{status.published ? 'לחץ להסתרה מהדיירים' : 'לחץ להצגה לדיירים'}</TooltipContent>
    </Tooltip>
  );
}
