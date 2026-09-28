'use client';

import { useState, type KeyboardEvent } from 'react';
import { Landmark, X } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { amountToInput } from '@/lib/finance/format';
import type { FinMonthStatus } from '@/lib/types/finance';

// "יתרת בנק לסוף החודש" — one optional figure per month, typed next to the
// month's publish switch and saved inline (PUT /api/finance/month-status,
// { month, bank_balance }; null clears it). Blur or Enter saves; Escape puts
// the saved value back; the × clears. Residents see it only while the
// "הצג יתרת בנק לדיירים" switch is on (/finance/settings). Same permission
// as the publish switch (finance:edit) — read-only otherwise.
export function BankBalanceField({ month, status: initial, canEdit, onChange }: {
  /** 'YYYY-MM' */
  month: string;
  status: FinMonthStatus;
  canEdit: boolean;
  onChange?: (status: FinMonthStatus) => void;
}) {
  const [saved, setSaved] = useState<number | null>(initial.bank_balance);
  const [text, setText] = useState(initial.bank_balance === null ? '' : amountToInput(initial.bank_balance));
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);

  async function save(next: number | null) {
    if (next === saved) return;
    setSaving(true);
    try {
      const r = await fetch('/api/finance/month-status', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ month, bank_balance: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { status?: FinMonthStatus; error?: string };
      if (!r.ok || !data.status) throw new Error(data.error ?? 'שמירה נכשלה');
      setSaved(data.status.bank_balance);
      setText(data.status.bank_balance === null ? '' : amountToInput(data.status.bank_balance));
      onChange?.(data.status);
      toast.success(next === null ? 'יתרת הבנק נמחקה' : 'יתרת הבנק נשמרה');
    } catch (err) {
      setText(saved === null ? '' : amountToInput(saved));
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function commit() {
    const raw = text.trim().replace(/,/g, '');
    if (raw === '') { setInvalid(false); void save(null); return; }
    const n = Number(raw);
    if (!Number.isFinite(n) || Math.round(n * 100) / 100 !== n) { setInvalid(true); return; }
    setInvalid(false);
    void save(n);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape') { setText(saved === null ? '' : amountToInput(saved)); setInvalid(false); e.currentTarget.blur(); }
  }

  const label = 'יתרת בנק לסוף החודש';

  if (!canEdit) {
    return (
      <span className="inline-flex h-[38px] items-center gap-1.5 rounded-[10px] border border-line bg-white px-3 text-sm font-semibold text-ink-2">
        <Landmark className="h-4 w-4 text-ink-3" aria-hidden />
        {label}
        <span dir="ltr" className="font-num tabular-nums text-ink">{saved === null ? '—' : `₪ ${saved.toLocaleString('he-IL')}`}</span>
      </span>
    );
  }

  return (
    <label className="flex h-11 items-center gap-2 px-1 text-sm font-semibold text-ink-2">
      <Landmark className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <span className="whitespace-nowrap">{label}</span>
      <span className="relative">
        <Input
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={text}
          disabled={saving}
          placeholder="—"
          aria-label={label}
          aria-invalid={invalid || undefined}
          onChange={(e) => { setText(e.target.value); if (invalid) setInvalid(false); }}
          onBlur={commit}
          onKeyDown={onKey}
          className={cn(
            'h-[38px] w-[150px] rounded-[10px] border-line bg-white ps-3 pe-9 text-start font-num text-sm tabular-nums text-ink',
            invalid && 'border-red-400 bg-red-50 focus:ring-red-200',
          )}
        />
        {saved !== null && !saving && (
          <button
            type="button"
            onClick={() => { setText(''); void save(null); }}
            aria-label="מחיקת יתרת הבנק"
            title="מחיקה"
            className="absolute end-1 top-1/2 grid h-[30px] w-[30px] -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-red-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </span>
    </label>
  );
}
