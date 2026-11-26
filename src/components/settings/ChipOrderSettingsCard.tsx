'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CreditCard, FileText, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DEFAULT_CHIP_ORDER_SETTINGS, type ChipOrderSettings } from '@/lib/chipOrders/model';
import { ChipOrderTestModeSection } from './ChipOrderTestModeSection';

/** Card payment as the server reports it (GET /api/settings/chip-orders →
 *  `payments`): yes / no only — never a value of a key. */
interface PaymentsState {
  /** PAYPLUS_MODE as set, or null. */
  mode: 'sandbox' | 'production' | null;
  sandboxConfigured: boolean;
  productionConfigured: boolean;
  /** PAYPLUS_LIVE_CHARGING=on */
  switchOn: boolean;
  /** Real charges are armed — the public page may open. */
  live: boolean;
}

/** The building's Morning account as the server reads it (`morning`): is a key
 *  set, the business type the account reports, and the document that follows. */
interface MorningState {
  configured: boolean;
  mode: 'sandbox' | 'production' | null;
  businessTypeLabel: string | null;
  docType: number | null;
  docTypeLabel: string | null;
  vatIncluded: boolean | null;
  summary: string;
  error: string | null;
}

interface SettingsAnswer {
  settings: ChipOrderSettings;
  payments?: PaymentsState | null;
  morning?: MorningState | null;
}

/**
 * Chip orders (/chip-order, 12/11/2026) — the price per chip (one flat price
 * since 21/11/2026: no threshold, no quantity limit), the pickup and terms
 * texts, and the page switch. The switch opens the page only when real card
 * charging is armed too (26/11/2026 — PayPlus: its mode, its keys and the
 * live-charging switch are server env). Under the form, READ ONLY: the state
 * of card payment (PayPlus) and of the documents (Morning) — yes / no and
 * labels only, never a key.
 */
export function ChipOrderSettingsCard({
  canEdit, canManageOrders = false, canEditOrders = false,
}: {
  canEdit: boolean;
  /** chips_orders_manage:view — sees the test-mode section (13/11/2026). */
  canManageOrders?: boolean;
  /** chips_orders_manage:edit — may switch it and make a new link. */
  canEditOrders?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  // A failed load must never let the defaults be saved over the real settings.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [payments, setPayments] = useState<PaymentsState | null>(null);
  const [morning, setMorning] = useState<MorningState | null>(null);
  const [form, setForm] = useState({
    unitPrice: String(DEFAULT_CHIP_ORDER_SETTINGS.unitPrice),
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
        const d = (await r.json()) as SettingsAnswer;
        if (cancelled) return;
        setPayments(d.payments ?? null);
        setMorning(d.morning ?? null);
        setForm({
          unitPrice: String(d.settings.unitPrice),
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
          pickupText: form.pickupText,
          termsText: form.termsText,
          ordersOpen: form.ordersOpen,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as Partial<SettingsAnswer> & { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      if (data.payments) setPayments(data.payments);
      if (data.morning) setMorning(data.morning);
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
        aria-describedby={hint ? `co-${id}-hint` : undefined}
        className="h-10 px-3 py-2 tabular-nums"
      />
      {hint && <p id={`co-${id}-hint`} className="text-[12px] text-slate-500">{hint}</p>}
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
          {/* ₪1 is a valid price (the first real charge is a ₪1 test, 26/11/2026);
              the server refuses anything under it, with its own message. */}
          {numField('unitPrice', 'מחיר לצ׳יפ (₪)', 'כל צ׳יפ באותו מחיר, לפחות ₪1. המחיר נשמר בכל הזמנה כפי שהיה ברגע ההזמנה.')}
        </div>

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
          <p className="text-[12px] text-slate-500">מוצגים בעמוד ההזמנה מעל תיבות האישור, לפני התשלום.</p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-4">
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">פתיחת ההזמנות לציבור</p>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              העמוד נפתח לדיירים רק כשהמתג דלוק וגם החיוב האמיתי פעיל; אחרת הוא מציג „ההזמנות ייפתחו בקרוב”.
              {payments && !payments.live && ' כרגע החיוב האמיתי כבוי, ולכן העמוד סגור גם כשהמתג דלוק.'}
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

      {!loadFailed && <PaymentsStatus loading={loading} payments={payments} morning={morning} />}

      {canManageOrders && (
        <div className="mt-6">
          <ChipOrderTestModeSection canEdit={canEditOrders} />
        </div>
      )}
    </Card>
  );
}

// ── Card payment and documents — read only (26/11/2026) ────────────────────

/** A yes / no fact: a status dot and the word. */
function Flag({ on, yes = 'כן', no = 'לא' }: { on: boolean; yes?: string; no?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden />
      {on ? yes : no}
    </span>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]" data-testid={testId}>{children}</dd>
    </div>
  );
}

const MODE_LABEL: Record<'sandbox' | 'production', string> = {
  sandbox: 'sandbox — סביבת בדיקות',
  production: 'production — סביבת ייצור',
};

function PaymentsStatus({ loading, payments, morning }: { loading: boolean; payments: PaymentsState | null; morning: MorningState | null }) {
  // While loading: "…"; loaded without the block (an older server): "—".
  const pending = loading ? '…' : '—';
  return (
    <section className="mt-6 flex flex-col gap-4" aria-labelledby="co-pay-status" data-testid="chip-order-payment-status">
      <div>
        <h3 id="co-pay-status" className="text-base font-bold text-slate-900">סליקה ומסמכים — מצב נוכחי</h3>
        <p className="mt-0.5 text-[12.5px] text-slate-500">לקריאה בלבד: נקבע במשתני הסביבה של השרת. מפתחות לא מוצגים כאן.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-200 p-4" data-testid="chip-order-payplus-status">
          <p className="flex items-center gap-2 font-semibold text-slate-900">
            <CreditCard className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            סליקה — PayPlus
          </p>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Fact label="מצב (PAYPLUS_MODE)">
              {loading || !payments ? pending : payments.mode ? MODE_LABEL[payments.mode] : 'לא מוגדר'}
            </Fact>
            <Fact label="סביבת בדיקות מוגדרת">{loading || !payments ? pending : <Flag on={payments.sandboxConfigured} />}</Fact>
            <Fact label="סביבת ייצור מוגדרת">{loading || !payments ? pending : <Flag on={payments.productionConfigured} />}</Fact>
            <Fact label="מתג החיוב האמיתי (PAYPLUS_LIVE_CHARGING)">
              {loading || !payments ? pending : <Flag on={payments.switchOn} yes="דלוק" no="כבוי" />}
            </Fact>
          </dl>
          {payments && (
            <p
              data-testid="chip-order-live-charging"
              className={cn(
                'rounded-md border p-3 text-sm font-semibold',
                payments.live ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900',
              )}
            >
              {payments.live ? 'חיוב אמיתי פעיל' : 'חיוב אמיתי כבוי — הדף הציבורי סגור לדיירים'}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-200 p-4" data-testid="chip-order-morning-status">
          <p className="flex items-center gap-2 font-semibold text-slate-900">
            <FileText className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            מסמכים — מורנינג
          </p>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Fact label="מפתח API מוגדר">{loading || !morning ? pending : <Flag on={morning.configured} />}</Fact>
            <Fact label="סביבה">
              {loading || !morning ? pending : morning.mode === 'production' ? 'ייצור' : morning.mode === 'sandbox' ? 'בדיקות (sandbox)' : '—'}
            </Fact>
            <Fact label="סוג העסק">{loading || !morning ? pending : morning.businessTypeLabel ?? '—'}</Fact>
            <Fact label="המסמך שיופק" testId="chip-order-morning-doctype">
              {loading || !morning ? pending : morning.docType
                ? <><span className="tabular-nums" dir="ltr">{morning.docType}</span> · {morning.docTypeLabel ?? ''}</>
                : '—'}
            </Fact>
            <Fact label="מע״מ">
              {loading || !morning ? pending : morning.docType ? (morning.vatIncluded ? 'המחיר כולל מע״מ' : 'ללא מע״מ') : '—'}
            </Fact>
          </dl>
          {morning && <p className="text-[12.5px] text-slate-600" data-testid="chip-order-morning-summary">{morning.summary}</p>}
          {morning?.error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 [overflow-wrap:anywhere]">
              שגיאה בקריאת חשבון המורנינג: {morning.error}
            </p>
          )}
          <p className="text-[12px] font-semibold text-amber-700">לאישור רואה החשבון לפני החיוב האמיתי הראשון.</p>
        </div>
      </div>
    </section>
  );
}
