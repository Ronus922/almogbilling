'use client';

// /chip-order — the public order form (12/11/2026). Three steps on one page:
//   1. details + apartment lines (live price per line and total);
//   2. phone verification — the portal's OTP (SMS first, WhatsApp fallback);
//   3. payment inside the page — Grow's payment page in an iframe; its
//      postMessage "payment" sends the browser to the tracking page.
// The browser's price is a preview: the server recomputes it from the settings.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Building2, CreditCard, FileUp, Loader2, Minus, Plus, ShieldCheck, Trash2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toPortalE164 } from '@/lib/portal/phone';
import {
  CHIP_ORDER_LIMITS, CHIP_ORDER_ROLE_LABEL, LEASE_FILE_ACCEPT, formatIls, needsLease, orderTotal, priceLine,
  type ChipOrderRole,
} from '@/lib/chipOrders/model';
import { leaseFileProblem } from '@/lib/chipOrders/lease';
import { ChipSection, INPUT_CLS, LABEL_CLS } from '@/components/chips/ChipSection';

interface Pricing {
  unitPrice: number;
  threshold: number;
  priceAbove: number;
  maxPerApartment: number;
}

interface Line {
  key: number;
  apartment: string;
  count: number;
  file: File | null;
  endDate: string;
}

type Step = 'form' | 'otp' | 'paying';

// Grow's payment iframe posts from one of these (R/postmessage).
const GROW_ORIGINS = ['https://meshulam.co.il', 'https://secure.meshulam.co.il', 'https://sandbox.meshulam.co.il'];
const PAID_ACTIONS = ['payment', 'bit_payment', 'apple_payment', 'google_payment'];

const FIELD = cn(INPUT_CLS, 'w-full text-[16px] sm:text-[14.5px]');
const ERR = 'border-red-400 bg-red-50';

function todayIso(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function ChipOrderForm({
  apartments, pricing, termsText,
}: {
  apartments: string[];
  pricing: Pricing;
  termsText: string;
}) {
  const router = useRouter();
  const seq = useRef(1);
  const [step, setStep] = useState<Step>('form');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<ChipOrderRole | null>(null);
  const [lines, setLines] = useState<Line[]>([{ key: 0, apartment: '', count: 1, file: null, endDate: '' }]);
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // OTP
  const [code, setCode] = useState('');
  const [otpInfo, setOtpInfo] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // The channel the last code went out on; a failed SMS offers WhatsApp (the
  // portal's own "שלח בוואטסאפ במקום").
  const [otpChannel, setOtpChannel] = useState<'sms' | 'whatsapp' | null>(null);
  const [offerWhatsApp, setOfferWhatsApp] = useState(false);

  // Payment
  const [payment, setPayment] = useState<{ url: string; trackUrl: string; orderNumber: number; total: number } | null>(null);
  const [payNote, setPayNote] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Grow's postMessage: a completed payment goes to the tracking page.
  useEffect(() => {
    if (step !== 'paying' || !payment) return;
    function onMessage(ev: MessageEvent) {
      if (!GROW_ORIGINS.includes(ev.origin)) return;
      const data = (ev.data ?? {}) as { action?: string; status?: number | string };
      if (data.action && PAID_ACTIONS.includes(data.action) && (data.action !== 'payment' || Number(data.status) === 1)) {
        router.push(`${new URL(payment!.trackUrl).pathname}?paid=1`);
      } else if (data.action === 'close') {
        setPayNote('חלון התשלום נסגר. אפשר לחזור אליו כל עוד לא עברו 10 דקות.');
      } else if (data.action === 'failed_to_load_page') {
        setPayNote('דף התשלום לא נטען. רעננו את הדף ונסו שוב.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [step, payment, router]);

  const priced = useMemo(() => lines.map((l) => priceLine(l.count, pricing)), [lines, pricing]);
  const total = orderTotal(priced);
  const usedApartments = new Set(lines.map((l) => l.apartment).filter(Boolean));
  const lease = role ? needsLease(role) : false;

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (fullName.trim().split(/\s+/).filter(Boolean).length < 2) e.fullName = 'נדרש שם מלא — שם פרטי ושם משפחה';
    const e164 = toPortalE164(phone);
    if (!e164 || !e164.startsWith('+9725')) e.phone = 'נדרש מספר טלפון נייד ישראלי';
    if (!z.email().safeParse(email.trim().toLowerCase()).success) e.email = 'כתובת מייל לא תקינה';
    if (address.trim().length < 2) e.address = 'נדרשת כתובת מגורים';
    if (!role) e.role = 'נדרש לבחור: בעלים, שוכר או מפעיל';
    lines.forEach((l, i) => {
      if (!l.apartment) e[`apt_${l.key}`] = 'נדרש לבחור דירה';
      else if (lines.findIndex((x) => x.apartment === l.apartment) !== i) e[`apt_${l.key}`] = 'הדירה כבר מופיעה בהזמנה';
      if (role && needsLease(role)) {
        if (!l.file) e[`file_${l.key}`] = 'נדרש לצרף חוזה או הסכם ניהול';
        else {
          const p = leaseFileProblem(l.file);
          if (p) e[`file_${l.key}`] = p;
        }
        if (!l.endDate) e[`end_${l.key}`] = 'נדרש תאריך סיום חוזה';
        else if (l.endDate < todayIso()) e[`end_${l.key}`] = 'תאריך סיום החוזה כבר עבר';
      }
    });
    if (role && needsLease(role)) {
      const total = lines.reduce((sum, l) => sum + (l.file?.size ?? 0), 0);
      const last = lines[lines.length - 1];
      if (total > CHIP_ORDER_LIMITS.maxLeaseBytesTotal && last) e[`file_${last.key}`] = 'כל הקבצים יחד עד 40MB בהזמנה אחת';
    }
    if (!accept) e.accept = 'נדרש לאשר את תנאי ההזמנה';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function requestCode(channel?: 'whatsapp') {
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch('/api/public/chip-order/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, ...(channel ? { channel } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; channel?: string; retryAfterSec?: number };
      if (!res.ok || !data.ok) {
        if (data.retryAfterSec) setCooldown(data.retryAfterSec);
        // A send that failed outright (not a ceiling) may still go out on WhatsApp.
        setOfferWhatsApp(res.status === 502 && channel !== 'whatsapp');
        throw new Error(data.message ?? 'שליחת הקוד נכשלה');
      }
      setOfferWhatsApp(false);
      setOtpChannel(data.channel === 'sms' ? 'sms' : 'whatsapp');
      setOtpInfo(data.channel === 'sms' ? 'שלחנו קוד בן 6 ספרות ב-SMS.' : 'שלחנו קוד בן 6 ספרות בוואטסאפ.');
      setCooldown(45);
      setCode('');
      setStep('otp');
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitOrder(): Promise<void> {
    const fd = new FormData();
    fd.append(
      'order',
      JSON.stringify({
        fullName: fullName.trim(),
        phone,
        email: email.trim(),
        address: address.trim(),
        role,
        acceptTerms: accept,
        lines: lines.map((l) => ({
          apartment: l.apartment,
          chipsCount: l.count,
          leaseEndDate: lease ? l.endDate || null : null,
        })),
      }),
    );
    if (lease) lines.forEach((l, i) => { if (l.file) fd.append(`lease_${i}`, l.file); });
    const res = await fetch('/api/public/chip-order', { method: 'POST', body: fd });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean; message?: string; needsOtp?: boolean;
      paymentUrl?: string; trackUrl?: string; orderNumber?: number; total?: number;
    };
    if (res.status === 401 && data.needsOtp) {
      setVerifiedPhone(null);
      await requestCode();
      return;
    }
    if (!res.ok || !data.ok || !data.paymentUrl || !data.trackUrl) throw new Error(data.message ?? 'שליחת ההזמנה נכשלה');
    setPayment({ url: data.paymentUrl, trackUrl: data.trackUrl, orderNumber: data.orderNumber ?? 0, total: data.total ?? total });
    setStep('paying');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function onContinue() {
    setServerError(null);
    if (!validate()) return;
    const e164 = toPortalE164(phone);
    if (verifiedPhone && verifiedPhone === e164) {
      setBusy(true);
      try { await submitOrder(); } catch (err) { setServerError((err as Error).message); } finally { setBusy(false); }
      return;
    }
    await requestCode();
  }

  async function onVerify() {
    if (!/^\d{6}$/.test(code)) {
      setServerError('הקוד חייב להכיל 6 ספרות');
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch('/api/public/chip-order/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) throw new Error(data.message ?? 'האימות נכשל');
      setVerifiedPhone(toPortalE164(phone));
      await submitOrder();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Payment step ─────────────────────────────────────────────────────────
  if (step === 'paying' && payment) {
    return (
      <ChipSection title={`תשלום — הזמנה ${payment.orderNumber}`} sub={`סה״כ לתשלום ${formatIls(payment.total)}`} icon={CreditCard} iconTone="green">
        <div className="flex flex-col gap-3">
          <iframe
            src={payment.url}
            title="תשלום מאובטח"
            allow="payment"
            className="h-[680px] w-full rounded-[11px] border border-[var(--chip-border)] bg-white"
            data-testid="chip-order-payment"
          />
          {payNote && (
            <p role="status" className="rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[13px] font-semibold text-[var(--chip-amber-ink)]">
              {payNote}
            </p>
          )}
          <p className="text-[12.5px] font-medium text-[var(--chip-ink-soft)]">
            התשלום מתבצע בדף המאובטח של Grow. החשבונית / הקבלה תופק ותישלח אליך מ-Grow.
          </p>
        </div>
      </ChipSection>
    );
  }

  // ── Form + OTP ───────────────────────────────────────────────────────────
  const locked = step === 'otp' || busy;
  return (
    <form
      className="flex flex-col gap-[18px]"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void (step === 'otp' ? onVerify() : onContinue()); }}
    >
      <ChipSection title="פרטי המזמין" icon={User} iconTone="violet">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={LABEL_CLS}>שם מלא</span>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" disabled={locked}
              className={cn(FIELD, errors.fullName && ERR)} />
            {errors.fullName && <span className="text-[12.5px] font-semibold text-red-600">{errors.fullName}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL_CLS}>טלפון נייד</span>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" dir="ltr" disabled={locked}
              placeholder="05X-XXXXXXX" className={cn(FIELD, 'text-end', errors.phone && ERR)} />
            {errors.phone && <span className="text-[12.5px] font-semibold text-red-600">{errors.phone}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL_CLS}>מייל</span>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoComplete="email" dir="ltr" disabled={locked}
              className={cn(FIELD, 'text-end', errors.email && ERR)} />
            {errors.email && <span className="text-[12.5px] font-semibold text-red-600">{errors.email}</span>}
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={LABEL_CLS}>כתובת מגורים</span>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" disabled={locked}
              className={cn(FIELD, errors.address && ERR)} />
            {errors.address && <span className="text-[12.5px] font-semibold text-red-600">{errors.address}</span>}
          </label>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={LABEL_CLS}>אני</span>
            <div role="radiogroup" aria-label="אני" className="grid grid-cols-3 gap-2 rounded-[13px] bg-[var(--chip-panel-alt)] p-1">
              {(['owner', 'tenant', 'operator'] as ChipOrderRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  disabled={locked}
                  onClick={() => setRole(r)}
                  className={cn(
                    'h-11 rounded-[10px] text-[14.5px] font-bold transition-colors',
                    role === r
                      ? 'bg-[var(--chip-brand)] text-white shadow-sm'
                      : 'text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
                  )}
                >
                  {CHIP_ORDER_ROLE_LABEL[r]}
                </button>
              ))}
            </div>
            {errors.role && <span className="text-[12.5px] font-semibold text-red-600">{errors.role}</span>}
          </div>
        </div>
      </ChipSection>

      <ChipSection
        title="דירות וצ׳יפים"
        sub={`עד ${pricing.threshold} צ׳יפים לדירה — ${formatIls(pricing.unitPrice)} לצ׳יפ; מהצ׳יפ ה-${pricing.threshold + 1} — ${formatIls(pricing.priceAbove)} לצ׳יפ`}
        icon={Building2}
        iconTone="blue"
      >
        <div className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <div key={l.key} className="flex flex-col gap-3 rounded-[13px] border border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-4" data-testid="chip-order-line">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-[140px] flex-1 flex-col gap-1.5">
                  <span className={LABEL_CLS}>דירה</span>
                  <select
                    value={l.apartment}
                    disabled={locked}
                    onChange={(e) => updateLine(l.key, { apartment: e.target.value })}
                    className={cn(FIELD, 'appearance-auto', errors[`apt_${l.key}`] && ERR)}
                    aria-label={`דירה ${i + 1}`}
                  >
                    <option value="">בחירת דירה</option>
                    {apartments.map((a) => (
                      <option key={a} value={a} disabled={usedApartments.has(a) && a !== l.apartment}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col gap-1.5">
                  <span className={LABEL_CLS}>כמות</span>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label="פחות" disabled={locked || l.count <= 1}
                      onClick={() => updateLine(l.key, { count: l.count - 1 })}
                      className="grid h-11 w-11 place-items-center rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-white disabled:opacity-40">
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="chip-num w-9 text-center text-[17px] font-bold" aria-live="polite">{l.count}</span>
                    <button type="button" aria-label="יותר" disabled={locked || l.count >= pricing.maxPerApartment}
                      onClick={() => updateLine(l.key, { count: l.count + 1 })}
                      className="grid h-11 w-11 place-items-center rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-white disabled:opacity-40">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="flex min-w-[72px] flex-col items-end gap-1.5">
                  <span className={LABEL_CLS}>מחיר</span>
                  <span className="flex h-11 items-center text-[16px] font-extrabold">{formatIls(priced[i].lineTotal)}</span>
                </div>
                {lines.length > 1 && (
                  <button type="button" aria-label={`הסרת דירה ${i + 1}`} disabled={locked}
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                    className="grid h-11 w-11 place-items-center rounded-[11px] text-[var(--chip-ink-soft)] hover:bg-[var(--chip-red-soft)] hover:text-[var(--chip-red)]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {errors[`apt_${l.key}`] && <span className="text-[12.5px] font-semibold text-red-600">{errors[`apt_${l.key}`]}</span>}

              {lease && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className={LABEL_CLS}>חוזה / הסכם ניהול (PDF או תמונה, עד 10MB)</span>
                    <span className={cn(
                      'flex h-11 cursor-pointer items-center gap-2 rounded-[11px] border-[1.5px] border-dashed border-[var(--chip-border-strong)] bg-white px-3 text-[14px] font-semibold text-[var(--chip-ink-muted)]',
                      errors[`file_${l.key}`] && ERR,
                    )}>
                      <FileUp className="h-4 w-4 shrink-0" />
                      <span className="truncate">{l.file ? l.file.name : 'בחירת קובץ'}</span>
                    </span>
                    <input type="file" accept={LEASE_FILE_ACCEPT} className="sr-only" disabled={locked}
                      onChange={(e) => updateLine(l.key, { file: e.target.files?.[0] ?? null })} />
                    {errors[`file_${l.key}`] && <span className="text-[12.5px] font-semibold text-red-600">{errors[`file_${l.key}`]}</span>}
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className={LABEL_CLS}>תאריך סיום החוזה</span>
                    <Input type="date" value={l.endDate} min={todayIso()} disabled={locked}
                      onChange={(e) => updateLine(l.key, { endDate: e.target.value })}
                      className={cn(FIELD, errors[`end_${l.key}`] && ERR)} />
                    {errors[`end_${l.key}`] && <span className="text-[12.5px] font-semibold text-red-600">{errors[`end_${l.key}`]}</span>}
                  </label>
                </div>
              )}
            </div>
          ))}

          {lines.length < CHIP_ORDER_LIMITS.maxApartmentsPerOrder && (
            <button
              type="button"
              disabled={locked}
              onClick={() => setLines((prev) => [...prev, { key: seq.current++, apartment: '', count: 1, file: null, endDate: '' }])}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-[13px] border-[1.5px] border-dashed border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] text-[14px] font-bold text-[var(--chip-brand-ink)] hover:bg-[var(--chip-hover)] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              הוספת דירה
            </button>
          )}

          <div className="flex items-center justify-between rounded-[13px] bg-[var(--chip-ink)] px-5 py-4 text-white">
            <span className="text-[15px] font-bold">סה״כ לתשלום</span>
            <span className="text-[22px] font-black" data-testid="chip-order-total">{formatIls(total)}</span>
          </div>
        </div>
      </ChipSection>

      <ChipSection title="אישור ותשלום" icon={ShieldCheck} iconTone="green">
        <div className="flex flex-col gap-4">
          {termsText.trim() && (
            <details className="rounded-[11px] border border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-4">
              <summary className="min-h-[24px] cursor-pointer text-[14px] font-bold">תנאי ההזמנה</summary>
              <p className="mt-2 whitespace-pre-line text-[13.5px] leading-relaxed text-[var(--chip-ink-muted)]">{termsText}</p>
            </details>
          )}
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
            <input type="checkbox" checked={accept} disabled={locked} onChange={(e) => setAccept(e.target.checked)}
              className="mt-0.5 h-[22px] w-[22px] shrink-0 accent-[var(--chip-green)]" />
            <span className="text-[14px] font-semibold">
              קראתי ואני מאשר/ת את תנאי ההזמנה, ושהפרטים שמסרתי נכונים.
            </span>
          </label>
          {errors.accept && <span className="text-[12.5px] font-semibold text-red-600">{errors.accept}</span>}

          {step === 'otp' && (
            <div className="flex flex-col gap-3 rounded-[13px] border border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] p-4">
              <p className="text-[14px] font-bold text-[var(--chip-brand-ink)]">{otpInfo ?? 'שלחנו קוד אימות לטלפון.'}</p>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={6}
                aria-label="קוד אימות"
                placeholder="______"
                className={cn(FIELD, 'chip-num h-14 text-center text-[26px] tracking-[0.4em]')}
                autoFocus
              />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy || cooldown > 0} onClick={() => void requestCode()}
                  className="min-h-[44px] text-[13.5px] font-bold text-[var(--chip-brand-ink)] underline-offset-2 hover:underline disabled:opacity-50">
                  {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown} שניות` : 'שליחת קוד חדש'}
                </button>
                {otpChannel === 'sms' && (
                  <button type="button" disabled={busy || cooldown > 0} onClick={() => void requestCode('whatsapp')}
                    className="min-h-[44px] text-[13.5px] font-bold text-[var(--chip-brand-ink)] underline-offset-2 hover:underline disabled:opacity-50">
                    שליחה בוואטסאפ במקום
                  </button>
                )}
                <button type="button" disabled={busy}
                  onClick={() => { setStep('form'); setCode(''); }}
                  className="min-h-[44px] text-[13.5px] font-bold text-[var(--chip-ink-muted)] underline-offset-2 hover:underline">
                  חזרה לעריכת הפרטים
                </button>
              </div>
            </div>
          )}

          {serverError && (
            <div role="alert" className="flex flex-col gap-2 rounded-[11px] border border-red-400 bg-red-50 p-4 text-[14px] font-semibold text-red-700">
              {serverError}
              {offerWhatsApp && (
                <button type="button" disabled={busy} onClick={() => void requestCode('whatsapp')}
                  className="min-h-[44px] w-fit text-[13.5px] font-bold text-[var(--chip-brand-ink)] underline underline-offset-2 disabled:opacity-50">
                  שליחת הקוד בוואטסאפ במקום
                </button>
              )}
            </div>
          )}

          <Button
            type="submit"
            disabled={busy}
            className="h-[52px] w-full gap-2 rounded-[13px] bg-[var(--chip-brand)] text-[16px] font-bold text-white hover:bg-[var(--chip-brand-hover)] disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {step === 'otp' ? 'אימות והמשך לתשלום' : `המשך לתשלום · ${formatIls(total)}`}
          </Button>
        </div>
      </ChipSection>
    </form>
  );
}
