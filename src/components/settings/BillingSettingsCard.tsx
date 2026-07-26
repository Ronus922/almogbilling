'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Calculator } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

/**
 * Billing rates — currently the management-fee price per square metre. It is a
 * REFERENCE rate: the apartment card keeps its own "דמי ניהול" field, and this
 * value never overwrites a fee that was entered manually.
 */
export function BillingSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feePerSqm, setFeePerSqm] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/billing', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as { managementFeePerSqm: number | null };
        if (!cancelled) setFeePerSqm(d.managementFeePerSqm === null ? '' : String(d.managementFeePerSqm));
      } catch {
        if (!cancelled) toast.error('טעינת הגדרות החיוב נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;

    const raw = feePerSqm.trim();
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        toast.error('יש להזין מחיר חיובי או להשאיר ריק');
        return;
      }
    }

    setSaving(true);
    try {
      const r = await fetch('/api/settings/billing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ managementFeePerSqm: raw === '' ? null : Number(raw) }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; recomputed?: number };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success(
        data.recomputed
          ? `הגדרות החיוב נשמרו — דמי הניהול עודכנו ב-${data.recomputed} דירות`
          : 'הגדרות החיוב נשמרו',
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
          <Calculator className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">תעריפי חיוב</h2>
          <p className="mt-1 text-sm text-slate-500">מחירון רוחבי לחישוב דמי ניהול</p>
        </div>
      </div>

      <form onSubmit={onSave} className="mt-6 flex flex-col gap-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="fee-per-sqm" className="text-base font-medium text-muted-foreground">
            מחיר דמי ניהול למ&quot;ר (₪)
          </Label>
          <Input
            id="fee-per-sqm"
            value={feePerSqm}
            onChange={(e) => setFeePerSqm(e.target.value)}
            placeholder="12"
            dir="ltr"
            inputMode="decimal"
            disabled={loading || saving}
            className="h-10 tabular-nums"
          />
          <p className="text-[12px] text-slate-500">
            דמי הניהול בכרטיס הדירה מחושבים אוטומטית: <span className="font-semibold">גודל הדירה במ&quot;ר × 150% × המחיר כאן</span>.
            שמירת תעריף חדש מעדכנת מחדש את דמי הניהול בכל הדירות שיש להן גודל.
            השאר ריק כדי לבטל את התעריף — אז השדה חוזר להזנה ידנית והערכים הקיימים נשמרים.
          </p>
        </div>

        <div className="flex justify-start">
          <Button type="submit" disabled={loading || saving} className="px-4 py-2">
            {saving ? 'שומר…' : 'שמור'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
