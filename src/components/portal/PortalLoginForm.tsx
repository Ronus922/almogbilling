'use client';

import {
  useEffect, useRef, useState,
  type ClipboardEvent, type FormEvent, type KeyboardEvent,
} from 'react';
import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle, ShieldCheck, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PortalLoginBrand } from '@/components/portal/PortalLoginBrand';
import {
  PORTAL_OTP_DIGITS, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TTL_MINUTES,
} from '@/lib/constants/portal';

// /portal/login — the whole screen: brand side + form pane, two steps on one
// page (phone → code). The screen is owned by this client component rather than
// by the page because the mobile code step swaps the brand hero for a top bar
// with a back chevron, and which step is showing is client state.
//
// Design: ref/proof/tenant-portal-login.md (≥901px) and
// ref/proof/tenant-login-mobile.md (≤900px). What the references show and this
// screen does NOT: the "אימייל וסיסמה" segmented control and its email mode,
// the Face ID / "remember me" returning-user screen, the SMS autofill chip, the
// "בקשת הצטרפות" link — none of them exists in the system (28/09/2026).
//
// Every message the resident reads comes from the SERVER's `message` field, so
// the wording of "not a registered owner" and of a lockout lives in exactly one
// place (src/lib/constants/portal.ts) and cannot drift between the two. The one
// client-side check is the reference's length guard: fewer than 9 digits never
// leaves the browser.
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

/** Reference rule: fewer than this many digits is not a phone number at all. */
const PHONE_MIN_DIGITS = 9;
const PHONE_INVALID_MESSAGE = 'יש להזין מספר טלפון תקין';

const EMPTY_CODE: readonly string[] = Array.from({ length: PORTAL_OTP_DIGITS }, () => '');

/** What the resident typed, echoed on the code step as 052-418-7730 when it is
 *  an Israeli local number (with or without the trunk 0); anything else is shown
 *  as typed. Display only — the server always receives the raw input. */
function formatPhoneForDisplay(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  const local = /^\d{9}$/.test(digits) ? `0${digits}` : digits;
  return /^0\d{9}$/.test(local)
    ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`
    : raw.trim();
}

function formatCountdown(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Field chrome (reference `.inp`): 1.5px line, soft field background, brand
// focus ring; error = red line on white. Mobile is 54px/12px, desktop 48px/11px.
const FIELD_BASE =
  'flex items-center rounded-xl border-[1.5px] transition-[border-color,background-color,box-shadow] duration-150 min-[901px]:rounded-[11px]';
const FIELD_IDLE =
  'border-[#E2E8F0] bg-[#F5F7FB] hover:border-[#CBD5E1] focus-within:border-brand focus-within:bg-white focus-within:ring-4 focus-within:ring-[rgba(61,90,254,0.12)]';
const FIELD_ERROR =
  'border-[#E5484D] bg-white focus-within:ring-4 focus-within:ring-[rgba(229,72,77,0.12)]';

const LINK_BUTTON =
  '-my-3 inline-flex min-h-[44px] items-center font-semibold text-brand transition-colors hover:text-[#2B3FB8] hover:underline disabled:pointer-events-none disabled:opacity-50';

const INLINE_MESSAGE =
  'flex items-start gap-1.5 text-[13.5px] font-medium leading-[1.5] min-[901px]:text-[13px]';

export function PortalLoginForm() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [digits, setDigits] = useState<string[]>([...EMPTY_CODE]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);
  // The last six digits that went to the server. The boxes submit by themselves
  // when the sixth digit lands — but never the same code twice: after a wrong
  // code the resident either changes a digit or presses the button.
  const lastSubmittedCode = useRef<string | null>(null);

  // Resend countdown. One interval, cleared on unmount and whenever it hits 0.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') boxRefs.current[0]?.focus();
  }, [step]);

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    if (busy || cooldown > 0) return;
    setError(null); setNotice(null);
    if (phone.replace(/\D+/g, '').length < PHONE_MIN_DIGITS) {
      setPhoneInvalid(true);
      return;
    }
    setPhoneInvalid(false);
    setBusy(true);
    try {
      const { data } = await post('/api/portal/otp/request', { phone: phone.trim() });
      if (data.sent) {
        const resend = step === 'code';
        setStep('code');
        setDigits([...EMPTY_CODE]);
        lastSubmittedCode.current = null;
        setCooldown(PORTAL_OTP_RESEND_COOLDOWN_SEC);
        // On the first send the code step's own subtitle says all of this; the
        // line is for a resend, where nothing else on the screen changes.
        if (resend) {
          setNotice(`נשלח קוד בוואטסאפ. הקוד תקף ל-${PORTAL_OTP_TTL_MINUTES} דקות.`);
          boxRefs.current[0]?.focus();
        }
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

  async function verifyCode(code: string, e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setError(null); setNotice(null);
    if (!new RegExp(`^\\d{${PORTAL_OTP_DIGITS}}$`).test(code)) {
      setError(`הקוד חייב להכיל ${PORTAL_OTP_DIGITS} ספרות`);
      return;
    }
    lastSubmittedCode.current = code;
    setBusy(true);
    try {
      const { data } = await post('/api/portal/otp/verify', { phone: phone.trim(), code });
      if (data.ok) {
        // Hard navigation so the session cookie is on the next request.
        window.location.assign('/portal');
        return;
      }
      setError(data.message ?? data.error ?? 'הקוד שהוזן שגוי. נסה שוב.');
      // The digits stay put: the resident fixes the wrong one and the form
      // re-submits by itself (a changed code), or presses the button.
      boxRefs.current[0]?.focus();
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setBusy(false);
    }
  }

  function backToPhone() {
    setStep('phone');
    setDigits([...EMPTY_CODE]);
    lastSubmittedCode.current = null;
    setError(null);
    setNotice(null);
  }

  // ── OTP boxes ──────────────────────────────────────────────────────────────

  /** Writes `insert` into the boxes from `start`, moves focus past the last
   *  digit written, and submits when all six are in and differ from the last
   *  code sent. Typing, paste and OS autofill all end up here. */
  function fillFrom(start: number, insert: string, base: readonly string[]) {
    const next = [...base];
    let k = start;
    for (const ch of insert) {
      if (k >= PORTAL_OTP_DIGITS) break;
      next[k] = ch;
      k += 1;
    }
    setDigits(next);
    boxRefs.current[Math.min(k, PORTAL_OTP_DIGITS - 1)]?.focus();
    const joined = next.join('');
    if (joined.length === PORTAL_OTP_DIGITS && joined !== lastSubmittedCode.current) {
      void verifyCode(joined);
    }
  }

  function handleBoxChange(i: number, value: string) {
    const typed = value.replace(/\D+/g, '');
    if (!typed) {
      const next = [...digits];
      next[i] = '';
      setDigits(next);
      return;
    }
    let insert = typed;
    // Typing over a filled box hands back old+new (or new+old): keep the new one.
    if (digits[i] && typed.length === 2) {
      insert = typed.startsWith(digits[i]) ? typed.slice(1) : typed.slice(0, 1);
    }
    fillFrom(i, insert, digits);
  }

  function handleBoxKeyDown(i: number, ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Backspace' && !digits[i] && i > 0) {
      ev.preventDefault();
      const next = [...digits];
      next[i - 1] = '';
      setDigits(next);
      boxRefs.current[i - 1]?.focus();
    } else if (ev.key === 'ArrowLeft' && i > 0) {
      ev.preventDefault();
      boxRefs.current[i - 1]?.focus();
    } else if (ev.key === 'ArrowRight' && i < PORTAL_OTP_DIGITS - 1) {
      ev.preventDefault();
      boxRefs.current[i + 1]?.focus();
    }
  }

  function handleBoxPaste(i: number, ev: ClipboardEvent<HTMLInputElement>) {
    const pasted = ev.clipboardData.getData('text').replace(/\D+/g, '');
    if (!pasted) return;
    ev.preventDefault();
    // A whole code pasted anywhere fills from the first box.
    fillFrom(pasted.length >= PORTAL_OTP_DIGITS ? 0 : i, pasted.slice(0, PORTAL_OTP_DIGITS), digits);
  }

  const code = digits.join('');
  const phoneFieldError = phoneInvalid || (step === 'phone' && error !== null);

  return (
    <div className="flex min-h-dvh flex-col bg-white min-[901px]:grid min-[901px]:grid-cols-[minmax(0,46fr)_minmax(0,54fr)]">
      <PortalLoginBrand className={cn(step === 'code' && 'hidden min-[901px]:flex')} />

      {/* Mobile, code step: the hero gives way to a top bar with "back". */}
      {step === 'code' && (
        <div className="flex h-[52px] shrink-0 items-center px-3 min-[901px]:hidden">
          <button
            type="button"
            onClick={backToPhone}
            disabled={busy}
            aria-label="חזרה"
            className="grid size-11 place-items-center rounded-xl text-[#0F172A] transition-colors hover:bg-[#F5F7FB] disabled:opacity-50"
          >
            <ChevronRight className="size-[22px]" strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      <section
        className={cn(
          'relative z-[1] flex flex-1 flex-col bg-white px-6 pb-[max(12px,env(safe-area-inset-bottom))]',
          step === 'code' ? 'pt-2' : '-mt-7 rounded-t-[28px] pt-7',
          'min-[901px]:mt-0 min-[901px]:items-center min-[901px]:justify-center min-[901px]:rounded-none min-[901px]:px-8 min-[901px]:py-12',
        )}
      >
        <form
          onSubmit={step === 'phone' ? requestCode : (e) => verifyCode(code, e)}
          noValidate
          className="flex w-full flex-1 flex-col min-[901px]:max-w-[400px] min-[901px]:flex-none"
        >
          {step === 'phone' ? (
            <>
              <h1 className="text-2xl font-extrabold text-[#0F172A] min-[901px]:text-[32px]">כניסת בעלי דירות</h1>
              <p className="mt-1.5 text-[15px] leading-[1.5] text-[#64748B] min-[901px]:mt-2 min-[901px]:leading-[1.55]">
                נשלח אליך קוד חד-פעמי בוואטסאפ למספר הטלפון הרשום בוועד הבית.
              </p>

              <div className="mt-6 flex flex-col gap-2 min-[901px]:mt-7">
                <Label htmlFor="portal-phone" className="text-sm font-semibold text-[#334155]">מספר טלפון</Label>
                <div className={cn(FIELD_BASE, 'h-[54px] min-[901px]:h-12', phoneFieldError ? FIELD_ERROR : FIELD_IDLE)}>
                  <span aria-hidden className="hidden w-11 shrink-0 place-items-center text-[#94A3B8] min-[901px]:grid">
                    <Smartphone className="size-[18px]" strokeWidth={1.8} />
                  </span>
                  <input
                    id="portal-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="050-000-0000"
                    dir="ltr"
                    value={phone}
                    onChange={(ev) => {
                      setPhone(ev.target.value);
                      if (phoneInvalid) setPhoneInvalid(false);
                    }}
                    aria-invalid={phoneFieldError || undefined}
                    aria-describedby={phoneInvalid ? 'portal-phone-error' : undefined}
                    className="h-full min-w-0 flex-1 bg-transparent px-3.5 text-end font-num text-[17px] font-semibold text-[#0F172A] outline-none placeholder:text-[#94A3B8] min-[901px]:text-[15px] min-[901px]:font-medium"
                    required
                  />
                  {/* Visual prefix only — the number is sent exactly as typed. */}
                  <span
                    dir="ltr"
                    aria-hidden
                    className="ms-3.5 flex h-[26px] shrink-0 items-center border-e border-[#E2E8F0] pe-3.5 font-num text-base font-semibold text-[#64748B] min-[901px]:ms-3 min-[901px]:h-auto min-[901px]:pe-3 min-[901px]:text-sm"
                  >
                    +972
                  </span>
                </div>
                {phoneInvalid && (
                  <p id="portal-phone-error" role="alert" className={cn(INLINE_MESSAGE, 'text-[#E5484D]')}>
                    <CircleAlert className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} aria-hidden />
                    {PHONE_INVALID_MESSAGE}
                  </p>
                )}
              </div>

              {error && (
                <div role="alert" className="mt-[18px] flex gap-2.5 rounded-xl bg-[#FDECEC] px-3.5 py-3 text-sm leading-[1.5] text-[#B03A3E]">
                  <CircleAlert className="mt-0.5 size-[18px] shrink-0" strokeWidth={2} aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              {/* Mobile: pinned to the bottom of the sheet. Desktop: in flow. */}
              <div className="mt-auto flex flex-col gap-1.5 pt-4 pb-3 min-[901px]:mt-0 min-[901px]:gap-0 min-[901px]:p-0">
                <Button
                  type="submit"
                  disabled={busy || cooldown > 0}
                  className="h-[54px] w-full rounded-[14px] text-[17px] min-[901px]:mt-7 min-[901px]:h-12 min-[901px]:rounded-[11px] min-[901px]:text-[16px]"
                >
                  {busy ? (
                    <>
                      <LoaderCircle className="size-[18px] animate-spin" aria-hidden />
                      שולח…
                    </>
                  ) : cooldown > 0 ? (
                    `שלח קוד אימות (${cooldown})`
                  ) : (
                    'שלח קוד אימות'
                  )}
                </Button>
                <p className="flex items-center justify-center gap-2 pb-1 text-[12.5px] text-[#64748B] min-[901px]:mt-8 min-[901px]:justify-start min-[901px]:gap-2.5 min-[901px]:rounded-[11px] min-[901px]:bg-[#F5F7FB] min-[901px]:px-3.5 min-[901px]:py-3 min-[901px]:text-[13px]">
                  <ShieldCheck className="size-[15px] shrink-0 min-[901px]:size-[18px]" strokeWidth={1.8} aria-hidden />
                  הגישה מוגבלת לבעלי דירות רשומים בבניין
                </p>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-extrabold text-[#0F172A] min-[901px]:text-[32px]">הזנת קוד</h1>
              <p className="mt-1.5 text-[15px] leading-[1.5] text-[#64748B] min-[901px]:mt-2 min-[901px]:leading-[1.55]">
                שלחנו קוד בן {PORTAL_OTP_DIGITS} ספרות בוואטסאפ למספר{' '}
                <b dir="ltr" className="font-num font-bold whitespace-nowrap text-[#0F172A]">{formatPhoneForDisplay(phone)}</b>
                . הקוד תקף ל-{PORTAL_OTP_TTL_MINUTES} דקות.
              </p>

              <div dir="ltr" className="mt-7 flex justify-between gap-2 min-[901px]:mt-6 min-[901px]:gap-2.5">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => { boxRefs.current[i] = el; }}
                    type="text"
                    // Numeric keypad on mobile; autocomplete lets the OS offer the code.
                    inputMode="numeric"
                    pattern="\d*"
                    autoComplete={i === 0 ? 'one-time-code' : 'off'}
                    aria-label={`ספרה ${i + 1} מתוך ${PORTAL_OTP_DIGITS}`}
                    value={d}
                    readOnly={busy}
                    onChange={(ev) => handleBoxChange(i, ev.target.value)}
                    onKeyDown={(ev) => handleBoxKeyDown(i, ev)}
                    onPaste={(ev) => handleBoxPaste(i, ev)}
                    onFocus={(ev) => ev.currentTarget.select()}
                    className={cn(
                      'h-[60px] w-full min-w-0 rounded-xl border-[1.5px] text-center font-num text-[26px] font-bold text-[#0F172A] outline-none transition-[border-color,background-color,box-shadow] duration-150 min-[901px]:h-14 min-[901px]:rounded-[11px] min-[901px]:text-[22px]',
                      error ? 'border-[#E5484D] bg-white' : d ? 'border-[#CBD5E1] bg-white' : 'border-[#E2E8F0] bg-[#F5F7FB]',
                      'focus:border-brand focus:bg-white focus:ring-4 focus:ring-[rgba(61,90,254,0.12)]',
                    )}
                  />
                ))}
              </div>

              {error && (
                <p role="alert" className={cn(INLINE_MESSAGE, 'mt-3 text-[#E5484D]')}>
                  <CircleAlert className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} aria-hidden />
                  {error}
                </p>
              )}
              {notice && !error && (
                <p role="status" className={cn(INLINE_MESSAGE, 'mt-3 text-[#0B7A3B]')}>
                  <CircleCheck className="mt-0.5 size-[15px] shrink-0" strokeWidth={2.2} aria-hidden />
                  {notice}
                </p>
              )}

              <div className="mt-4 flex items-center justify-between gap-3 text-sm text-[#64748B] min-[901px]:mt-3.5">
                <button type="button" onClick={backToPhone} disabled={busy} className={LINK_BUTTON}>
                  שינוי מספר
                </button>
                {cooldown > 0 ? (
                  <span className="-my-3 inline-flex min-h-[44px] items-center gap-1">
                    שליחה חוזרת בעוד
                    <b dir="ltr" className="font-num font-bold">{formatCountdown(cooldown)}</b>
                  </span>
                ) : (
                  <button type="button" onClick={() => requestCode()} disabled={busy} className={LINK_BUTTON}>
                    שליחה חוזרת
                  </button>
                )}
              </div>

              <div className="mt-auto pt-4 pb-3 min-[901px]:mt-0 min-[901px]:p-0">
                <Button
                  type="submit"
                  disabled={busy}
                  className="h-[54px] w-full rounded-[14px] text-[17px] min-[901px]:mt-7 min-[901px]:h-12 min-[901px]:rounded-[11px] min-[901px]:text-[16px]"
                >
                  {busy ? (
                    <>
                      <LoaderCircle className="size-[18px] animate-spin" aria-hidden />
                      מאמת…
                    </>
                  ) : (
                    'כניסה לפורטל'
                  )}
                </Button>
              </div>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
