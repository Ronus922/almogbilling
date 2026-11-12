'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { DEFAULT_CHIP_ORDER_SETTINGS, formatIls, priceLine, type ChipOrderSettings } from '@/lib/chipOrders/model';

/**
 * Chip orders (/chip-order, 12/11/2026) — the price rule, the per-apartment
 * maximum, the pickup and terms texts, and the page switch. The switch opens
 * the page only when Grow is configured too (its identifiers are server env,
 * never shown here — only whether they exist).
 */
export function ChipOrderSettingsCard({ canEdit }: { canEdit: boolean }) {
  const [loading, setLoading] = useState(true);
  // A failed load must never let the defaults be saved over the real settings.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [growMode, setGrowMode] = useState<'production' | 'sandbox' | null>(null);
  const [form, setForm] = useState({
    unitPrice: String(DEFAULT_CHIP_ORDER_SETTINGS.unitPrice),
    threshold: String(DEFAULT_CHIP_ORDER_SETTINGS.threshold),
    priceAbove: String(DEFAULT_CHIP_ORDER_SETTINGS.priceAbove),
    maxPerApartment: String(DEFAULT_CHIP_ORDER_SETTINGS.maxPerApartment),
    pickupText: '',
    termsText: '',
    ordersOpen: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/chip-orders', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as { settings: ChipOrderSettings; growMode: 'production' | 'sandbox' | null };
        if (cancelled) return;
        setGrowMode(d.growMode);
        setForm({
          unitPrice: String(d.settings.unitPrice),
          threshold: String(d.settings.threshold),
          priceAbove: String(d.settings.priceAbove),
          maxPerApartment: String(d.settings.maxPerApartment),
          pickupText: d.settings.pickupText,
          termsText: d.settings.termsText,
          ordersOpen: d.settings.ordersOpen,
        });
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          toast.error('טעינת הגדרות הזמנת הצ׳יפים נכשלה — רעננו את הדף');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
  const example = (() => {
    const s = { unitPrice: num(form.unitPrice), threshold: num(form.threshold), priceAbove: num(form.priceAbove) };
    if (![s.unitPrice, s.threshold, s.priceAbove].every(Number.isFinite)) return null;
    const n = Math.max(1, Math.min(num(form.maxPerApartment) || 1, Math.trunc(s.threshold) + 1));
    return { n, total: priceLine(n, s).lineTotal };
  })();

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const r = await fetch('/api/settings/chip-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          unitPrice: num(form.unitPrice),
          threshold: num(form.threshold),
          priceAbove: num(form.priceAbove),
          maxPerApartment: num(form.maxPerApartment),
          pickupText: form.pickupText,
          termsText: form.termsText,
          ordersOpen: form.ordersOpen,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success('הגדרות הזמנת הצ׳יפים נשמרו');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || !canEdit || loadFailed;
  const numField = (id: keyof typeof form, label: string, hint?: string) => (
    <div className="space-y-2">
      <Label htmlFor={`co-${id}`} className="text-base font-medium text-muted-foreground">{label}</Label>
      <Input
        id={`co-${id}`}
        value={String(form[id])}
        onChange={(e) => set(id, e.target.value)}
        dir="ltr"
        inputMode="decimal"
        disabled={disabled}
        className="h-10 px-3 py-2 tabular-nums"
      />
      {hint && <p className="text-[12px] text-slate-500">{hint}</p>}
    </div>
  );

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6" data-testid="chip-order-settings">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">הזמנת צ׳יפים למעלית</h2>
          <p className="mt-1 text-sm text-slate-500">מחירון, מקום איסוף ופתיחת העמוד הציבורי /chip-order</p>
        </div>
      </div>

      <form onSubmit={onSave} className="mt-6 flex flex-col gap-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {numField('unitPrice', 'מחיר לצ׳יפ (₪)')}
          {numField('threshold', 'סף — כמה צ׳יפים לדירה במחיר הבסיס')}
          {numField('priceAbove', 'מחיר לצ׳יפ מעל הסף (₪)')}
          {numField('maxPerApartment', 'מקסימום צ׳יפים לדירה בהזמנה')}
        </div>
        {example && (
          <p className="rounded-lg bg-slate-50 p-3 text-[13px] text-slate-600">
            לדוגמה: {example.n} צ׳יפים לדירה אחת = {formatIls(example.total)}. התמחור לכל דירה בנפרד, והמחיר נשמר בכל הזמנה כפי שהיה ברגע ההזמנה.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="co-pickup" className="text-base font-medium text-muted-foreground">מקום ושעות איסוף</Label>
          <Textarea
            id="co-pickup"
            value={form.pickupText}
            onChange={(e) => set('pickupText', e.target.value)}
            placeholder="לדוגמה: משרד חברת הניהול, קומת הלובי · א׳–ה׳ 09:00–13:00"
            maxLength={500}
            disabled={disabled}
            className="min-h-[72px] px-3 py-2"
          />
          <p className="text-[12px] text-slate-500">נשלח למזמין בהודעת „מוכן לאיסוף” ומוצג בעמוד המעקב.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="co-terms" className="text-base font-medium text-muted-foreground">תנאי ההזמנה</Label>
          <Textarea
            id="co-terms"
            value={form.termsText}
            onChange={(e) => set('termsText', e.target.value)}
            placeholder="תנאי ההזמנה, ביטול והחזרים — מוצגים בעמוד ההזמנה לפני התשלום"
            maxLength={4000}
            disabled={disabled}
            className="min-h-[96px] px-3 py-2"
          />
          <p className="text-[12px] text-slate-500">Grow דורשת תיבת אישור תנאים בעמוד התשלום לפני העלייה לאוויר.</p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-4">
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">פתיחת ההזמנות לציבור</p>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              {growMode === 'production'
                ? 'Grow מחובר (סביבת ייצור — חיוב אמיתי). כשהמתג כבוי העמוד מציג „ההזמנות ייפתחו בקרוב”.'
                : growMode === 'sandbox'
                  ? 'Grow מחובר בסביבת בדיקות (sandbox) — תשלומים בכרטיסי בדיקה, בלי חיוב אמיתי. העמוד מציג פס „סביבת בדיקות”.'
                  : 'Grow עדיין לא מחובר (חסרים GROW_USER_ID / GROW_PAGE_CODE / GROW_ENV בשרת) — העמוד נשאר סגור גם כשהמתג דלוק.'}
            </p>
          </div>
          <Switch
            checked={form.ordersOpen}
            onCheckedChange={(v) => set('ordersOpen', v === true)}
            disabled={disabled}
            aria-label="פתיחת ההזמנות לציבור"
          />
        </div>

        {canEdit && (
          <div className="flex justify-start">
            <Button type="submit" disabled={disabled} className="px-4 py-2">
              {saving ? 'שומר…' : 'שמור'}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
