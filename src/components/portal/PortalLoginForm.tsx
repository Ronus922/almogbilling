'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, Phone, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PORTAL_OTP_DIGITS, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TTL_MINUTES,
} from '@/lib/constants/portal';

// /portal/login — two steps on one screen: phone → code.
//
// Every message the resident reads comes from the SERVER's `message` field, so
// the wording of "not a registered owner" and of a lockout lives in exactly one
// place (src/lib/constants/portal.ts) and cannot drift between the two.
//
// The "not registered" answer is a 200 with a message and no `sent` flag — the
// form stays on step 1 and shows it, which is the deliberate product decision to
// tell the owner to call the management company.

type Step = 'phone' | 'code';

interface ApiResponse {
  ok?: boolean;
  sent?: boolean;
  locked?: boolean;
  message?: string;
  retryAfterSec?: number;
  error?: string;
}

async function post(url: string, body: unknown): Promise<{ status: number; data: ApiResponse }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  let data: ApiResponse = {};
  try { data = (await res.json()) as ApiResponse; } catch { /* keep {} */ }
  return { status: res.status, data };
}

export function PortalLoginForm() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // Resend countdown. One interval, cleared on unmount and whenever it hits 0.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    if (busy || cooldown > 0) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const { data } = await post('/api/portal/otp/request', { phone: phone.trim() });
      if (data.sent) {
        setStep('code');
        setCode('');
        setCooldown(PORTAL_OTP_RESEND_COOLDOWN_SEC);
        setNotice(`נשלח קוד בוואטסאפ. הקוד תקף ל-${PORTAL_OTP_TTL_MINUTES} דקות.`);
        return;
      }
      // Not registered / inactive / locked / throttled / send failure — the server
      // says what to show. Stay on the step the resident is on.
      setError(data.message ?? data.error ?? 'שליחת הקוד נכשלה. נסה שוב.');
      if (typeof data.retryAfterSec === 'number' && data.retryAfterSec > 0) {
        setCooldown(data.retryAfterSec);
      }
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setNotice(null);
    if (!/^\d{6}$/.test(code)) {
      setError(`הקוד חייב להכיל ${PORTAL_OTP_DIGITS} ספרות`);
      return;
    }
    setBusy(true);
    try {
      const { data } = await post('/api/portal/otp/verify', { phone: phone.trim(), code });
      if (data.ok) {
        // Hard navigation so the session cookie is on the next request.
        window.location.href = '/portal';
        return;
      }
      setError(data.message ?? data.error ?? 'הקוד שהוזן שגוי. נסה שוב.');
      setCode('');
      codeRef.current?.focus();
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setBusy(false);
    }
  }

  function backToPhone() {
    setStep('phone');
    setCode('');
    setError(null);
    setNotice(null);
  }

  return (
    <form onSubmit={step === 'phone' ? requestCode : verifyCode} className="flex flex-col gap-5" noValidate>
      <div>
        <h1 className="text-[26px] font-extrabold tracking-tight text-slate-900">כניסת בעלי דירות</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {step === 'phone'
            ? 'הזן את מספר הטלפון הרשום שלך — נשלח לך קוד בוואטסאפ'
            : `הזן את ${PORTAL_OTP_DIGITS} הספרות שנשלחו ל-${phone.trim()}`}
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          {notice}
        </div>
      )}

      {step === 'phone' ? (
        <div className="space-y-2">
          <Label htmlFor="portal-phone" className="text-[13px] font-semibold text-slate-700">מספר טלפון</Label>
          <div className="relative">
            <Input
              id="portal-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="050-0000000"
              value={phone}
              onChange={(ev) => setPhone(ev.target.value)}
              className="h-12 rounded-xl pe-11 font-num tabular-nums"
              dir="ltr"
              required
            />
            <Phone className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="portal-code" className="text-[13px] font-semibold text-slate-700">קוד מוואטסאפ</Label>
          <div className="relative">
            <Input
              ref={codeRef}
              id="portal-code"
              name="code"
              type="text"
              // Numeric keypad on mobile; autocomplete lets the OS offer the code.
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={PORTAL_OTP_DIGITS}
              placeholder="000000"
              value={code}
              onChange={(ev) => setCode(ev.target.value.replace(/\D+/g, '').slice(0, PORTAL_OTP_DIGITS))}
              className="h-12 rounded-xl pe-11 text-center font-num text-xl tracking-[0.5em] tabular-nums"
              dir="ltr"
              required
            />
            <KeyRound className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden />
          </div>
        </div>
      )}

      <Button type="submit" size="lg" disabled={busy || (step === 'phone' && cooldown > 0)} className="w-full gap-2">
        {busy
          ? (step === 'phone' ? 'שולח…' : 'מאמת…')
          : step === 'phone'
            ? (cooldown > 0 ? `שלח קוד (${cooldown})` : 'שלח קוד')
            : <>כניסה<ArrowLeft className="h-[18px] w-[18px]" aria-hidden /></>}
      </Button>

      {step === 'code' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={backToPhone} disabled={busy} className="gap-2">
            שינוי מספר
          </Button>
          <Button type="button" variant="ghost" onClick={() => requestCode()} disabled={busy || cooldown > 0} className="gap-2">
            <RotateCcw className="h-4 w-4" aria-hidden />
            {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown}` : 'שלח קוד מחדש'}
          </Button>
        </div>
      )}

      <p className="text-center text-xs text-slate-400">
        הכניסה מיועדת לבעלי דירות בבניין. לשאלות — פנה לחברת הניהול.
      </p>
    </form>
  );
}
