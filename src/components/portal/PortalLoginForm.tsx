'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, CircleAlert, LoaderCircle, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PortalLoginBrand } from '@/components/portal/PortalLoginBrand';
import { PortalOtpStep, type OtpRequestOutcome } from '@/components/portal/PortalOtpStep';
import { PortalSupportAction, type PortalSupport } from '@/components/portal/PortalSupportAction';
import { BTN, BTN_SEC } from './portalButtons';
import { joinRequestSubject } from '@/lib/portal/support';
import { PORTAL_OTP_RESEND_COOLDOWN_SEC, pointsAtManagementCompany } from '@/lib/constants/portal';

// /portal/login — the whole screen: brand side + form pane, two steps on one
// page (phone → code). The screen is owned by this client component rather than
// by the page because the mobile code step swaps the brand hero for a top bar
// with a back chevron, and which step is showing is client state.
//
// Design: ref/proof/tenant-portal-login.md (≥901px), ref/Tenant Portal.html
// ≤900 rule between 601 and 900px (one column, a brand strip with the logo
// only, the desktop field sizes, pane 40px 20px — 28/09/2026) and
// ref/proof/tenant-login-mobile.md (≤600px, untouched since PR #43). What the references show and this
// screen does NOT: the "אימייל וסיסמה" segmented control and its email mode,
// the Face ID / "remember me" returning-user screen, the SMS autofill chip, the
// "בקשת הצטרפות" link — none of them exists in the system (28/09/2026).
//
// Step 2 lives in PortalOtpStep: all sixteen states of ref/OTP States.html,
// rebuilt on 29/09/2026. This file keeps step 1 and owns the code REQUEST,
// because the first send and every resend are the same call.
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
  lockedUntil?: string | null;
  notRegistered?: boolean;
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

/** Reference rule for Israel: fewer than this many subscriber digits is not a
 *  phone number at all. */
const PHONE_MIN_DIGITS = 9;
const PHONE_INVALID_MESSAGE = 'יש להזין מספר טלפון תקין';
/** The country prefix the field opens with (digits only; the '+' is drawn). */
const DEFAULT_PREFIX = '972';
/** ITU-T E.164: '+', then 7–15 digits, the first one 1–9. The server applies
 *  the same rule (normalizePhone / toPortalE164) — this is only the early "not
 *  a number at all" check the reference makes before sending. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** What goes to the server: '+' + prefix + number, the number's leading 0
 *  dropped when there is a prefix ('+972' + '054…' → '+97254…'). A number the
 *  resident typed with its own '+' is sent as is (an autofill of the full
 *  international number). With an empty prefix the number goes exactly as
 *  typed and the server decides — the pre-28/09/2026 behaviour. */
function composePhone(prefixDigits: string, typed: string): string {
  const raw = typed.trim();
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
  if (!prefixDigits) return raw;
  let n = raw.replace(/\D+/g, '');
  if (n.startsWith('0')) n = n.slice(1);
  return `+${prefixDigits}${n}`;
}

/** Client-side plausibility before the request: E.164 length for a prefixed
 *  number, plus the reference's nine-digit floor for Israel. */
function isPlausiblePhone(prefixDigits: string, typed: string): boolean {
  const full = composePhone(prefixDigits, typed);
  if (!full.startsWith('+')) return full.replace(/\D+/g, '').length >= PHONE_MIN_DIGITS;
  if (!E164_RE.test(full)) return false;
  return !full.startsWith(`+${DEFAULT_PREFIX}`) || full.length - 1 - DEFAULT_PREFIX.length >= PHONE_MIN_DIGITS;
}


/** The number echoed on the code step: 052-418-7730 for an Israeli number
 *  (with or without the trunk 0, under the +972 prefix or none); a foreign
 *  number is shown as the E.164 that was sent. Display only. */
function formatPhoneForDisplay(prefixDigits: string, typed: string): string {
  const full = composePhone(prefixDigits, typed);
  const digits = full.startsWith(`+${DEFAULT_PREFIX}`)
    ? `0${full.slice(1 + DEFAULT_PREFIX.length)}`
    : full.startsWith('+') ? '' : full.replace(/\D+/g, '');
  const local = /^\d{9}$/.test(digits) ? `0${digits}` : digits;
  return /^0\d{9}$/.test(local)
    ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`
    : full;
}

// Field chrome (reference `.inp`): 1.5px line, soft field background, brand
// focus ring; error = red line on white. Mobile is 54px/12px, desktop 48px/11px.
const FIELD_BASE =
  'flex items-center rounded-[12px] border-[1.5px] transition-[border-color,background-color,box-shadow] duration-150 min-[601px]:rounded-[11px]';
const FIELD_IDLE =
  'border-[#E2E8F0] bg-[#F5F7FB] min-[601px]:hover:border-[#CBD5E1] focus-within:border-brand focus-within:bg-white focus-within:ring-4 focus-within:ring-[rgba(61,90,254,0.12)]';
const FIELD_ERROR =
  'border-[#E5484D] bg-white focus-within:ring-4 focus-within:ring-[rgba(229,72,77,0.12)]';


// The prefix chip (reference `.pre`): separator line, muted Inter, 16px on
// the phone / 14px on the desktop. The same classes dress the edit field.
const PREFIX_CHIP = 'flex h-[26px] shrink-0 items-center border-e border-[#E2E8F0] ps-[14px] pe-[14px] font-num text-[16px] font-semibold leading-[normal] text-[#64748B] min-[601px]:ms-[12px] min-[601px]:h-auto min-[601px]:ps-0 min-[601px]:pe-[12px] min-[601px]:text-[14px]';
const INLINE_MESSAGE =
  'flex items-center gap-[6px] text-[13.5px] font-medium leading-[normal] min-[601px]:text-[13px]';

export function PortalLoginForm({ support = { phone: null, email: null } }: {
  /** NEXT_PUBLIC_PORTAL_SUPPORT_PHONE / _EMAIL, read on the server and handed
   *  down — the lock screens' "פנייה לחברת הניהול" uses them. */
  support?: PortalSupport;
}) {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  // Country prefix, digits only ('972'). A button until the resident presses
  // it, then a free field — no list, no flags (decision 28/09/2026).
  const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
  const [prefixEditing, setPrefixEditing] = useState(false);
  // Exactly the string the request carried — the verify step sends the same one.
  const [sentPhone, setSentPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  /**
   * State 16 — "המספר לא מזוהה". An INLINE message under the field since
   * 30/09/2026 (Ronen's decision), not the reference's bottom sheet: an
   * unregistered number is almost always a typo, and a window that has to be
   * dismissed before the number can be corrected is in the way of the one
   * thing the person came to do. The field keeps its value and its focus; the
   * details of the management company sit inside the message, open.
   *
   * It holds the number the answer was about, so correcting the field cannot
   * leave a message pointing at a number that is no longer on screen.
   */
  const [unregistered, setUnregistered] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  // Step 1's own resend guard — step 2 runs its own timer off the same value.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  /** The one code-request call: step 1's submit and step 2's resend. */
  async function requestCode(): Promise<OtpRequestOutcome> {
    const outgoing = composePhone(prefix, phone);
    const { status, data } = await post('/api/portal/otp/request', { phone: outgoing });
    if (data.sent) {
      setSentPhone(outgoing);
      setCooldown(PORTAL_OTP_RESEND_COOLDOWN_SEC);
      return { sent: true };
    }
    if (typeof data.retryAfterSec === 'number' && data.retryAfterSec > 0) setCooldown(data.retryAfterSec);
    return {
      sent: false,
      locked: data.locked === true || status === 429,
      lockedUntil: data.lockedUntil ?? null,
      notRegistered: data.notRegistered === true,
      message: data.message ?? data.error,
      retryAfterSec: data.retryAfterSec,
    };
  }

  /** Step 1's submit. A "not registered" answer is a 200 with a message and no
   *  `sent` flag — the form stays here and shows it, which is the deliberate
   *  product decision to send the owner to the management company. */
  async function submitPhone(e?: FormEvent) {
    e?.preventDefault();
    if (busy || cooldown > 0) return;
    setError(null);
    setUnregistered(null);
    if (!isPlausiblePhone(prefix, phone)) {
      setPhoneInvalid(true);
      return;
    }
    setPhoneInvalid(false);
    setBusy(true);
    try {
      const out = await requestCode();
      if (out.sent) { setStep('code'); return; }
      if (out.notRegistered) {
        setUnregistered(formatPhoneForDisplay(prefix, phone));
        // Straight back to the field: the correction is the next thing to do.
        phoneRef.current?.focus();
        return;
      }
      setError(out.message ?? 'שליחת הקוד נכשלה. נסה שוב.');
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setBusy(false);
    }
  }

  function backToPhone() {
    setStep('phone');
    setError(null);
  }

  /** The code step found the number is no longer an owner (it was when the
   *  code was sent). One presentation for one answer: back to the field, with
   *  the same inline message the first submit would have produced. */
  function notRegisteredFromCodeStep() {
    setStep('phone');
    setError(null);
    setUnregistered(formatPhoneForDisplay(prefix, phone));
  }

  const phoneFieldError = phoneInvalid || error !== null;

  return (
    <div className="flex min-h-dvh flex-col bg-white min-[901px]:grid min-[901px]:grid-cols-[minmax(0,46fr)_minmax(0,54fr)]">
      <PortalLoginBrand className={cn(step === 'code' && 'hidden min-[601px]:block min-[901px]:flex')} />

      {/* Mobile, code step: the hero gives way to a top bar with "back". */}
      {step === 'code' && (
        <div className="flex h-[52px] shrink-0 items-center px-[12px] min-[601px]:hidden">
          <button
            type="button"
            onClick={backToPhone}
            disabled={busy}
            aria-label="חזרה"
            className="grid size-[44px] place-items-center rounded-[12px] text-[#0F172A] disabled:opacity-50"
          >
            <ChevronRight className="size-[22px]" strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      <section
        className={cn(
          'relative z-[2] flex flex-1 flex-col bg-white px-[24px] pb-[env(safe-area-inset-bottom)]',
          step === 'code' ? 'pt-[8px]' : '-mt-[28px] rounded-t-[28px] pt-[28px]',
          'min-[601px]:mt-0 min-[601px]:items-center min-[601px]:justify-center min-[601px]:rounded-none min-[601px]:px-[20px] min-[601px]:py-[40px] min-[901px]:px-[32px] min-[901px]:py-[48px]',
        )}
      >
        {step === 'phone' ? (
        <form
          onSubmit={submitPhone}
          noValidate
          className="flex w-full flex-1 flex-col min-[601px]:max-w-[400px] min-[601px]:flex-none"
        >
              <h1 className="text-[24px] font-extrabold leading-[normal] text-[#0F172A] min-[601px]:text-[32px]">כניסת בעלי דירות</h1>
              <p className="mt-[6px] text-[15px] leading-[1.5] text-[#64748B] min-[601px]:mt-[8px] min-[601px]:leading-[1.55]">
                נשלח אליך קוד חד-פעמי בוואטסאפ למספר הטלפון הרשום בוועד הבית.
              </p>

              <div className="mt-[20px] flex flex-col gap-[8px] min-[601px]:mt-[24px]">
                <Label htmlFor="portal-phone" className="text-[14px] font-semibold leading-[normal] text-[#334155]">מספר טלפון</Label>
                <div className={cn(FIELD_BASE, 'h-[54px] min-[601px]:h-[48px]', phoneFieldError ? FIELD_ERROR : FIELD_IDLE)}>
                  <span aria-hidden className="hidden w-[44px] shrink-0 place-items-center text-[#94A3B8] min-[601px]:grid">
                    <Smartphone className="size-[18px]" strokeWidth={1.8} />
                  </span>
                  <input
                    id="portal-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    placeholder="050-000-0000"
                    dir="ltr"
                    value={phone}
                    ref={phoneRef}
                    onChange={(ev) => {
                      setPhone(ev.target.value);
                      if (phoneInvalid) setPhoneInvalid(false);
                      if (unregistered) setUnregistered(null);
                    }}
                    aria-invalid={phoneFieldError || undefined}
                    aria-describedby={phoneInvalid ? 'portal-phone-error' : undefined}
                    className="h-full min-w-0 flex-1 bg-transparent px-[14px] text-end font-num text-[17px] font-semibold text-[#0F172A] outline-none placeholder:font-medium placeholder:text-[#94A3B8] min-[601px]:text-[15px] min-[601px]:font-medium"
                    required
                  />
                  {/* Country prefix: the reference's chip, pressed → a free field
                      ('+' and up to four digits). The field's own focus ring marks
                      the edit; the number is composed on submit (composePhone). */}
                  {prefixEditing ? (
                    <input
                      aria-label="קידומת מדינה"
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      dir="ltr"
                      autoFocus
                      maxLength={5}
                      value={`+${prefix}`}
                      onChange={(ev) => {
                        setPrefix(ev.target.value.replace(/\D+/g, '').slice(0, 4));
                        if (phoneInvalid) setPhoneInvalid(false);
                      }}
                      // content-box: the width is the digits' own, the chip's padding
                      // is added outside it (border-box would eat it — invisible text).
                      style={{ width: `${prefix.length + 1.75}ch` }}
                      className={cn(PREFIX_CHIP, 'box-content bg-transparent text-[#0F172A] outline-none')}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPrefixEditing(true)}
                      aria-label={`קידומת מדינה +${prefix} — לחיצה לעריכה`}
                      className="flex h-full shrink-0 items-center"
                    >
                      <span dir="ltr" className={PREFIX_CHIP}>+{prefix}</span>
                    </button>
                  )}
                </div>
                {phoneInvalid && (
                  <p id="portal-phone-error" role="alert" className={cn(INLINE_MESSAGE, 'text-[#E5484D]')}>
                    <CircleAlert className="size-[15px] shrink-0" strokeWidth={2.2} aria-hidden />
                    {PHONE_INVALID_MESSAGE}
                  </p>
                )}
              </div>

              {/* 16 — inline, amber, and already carrying the way to act on
                  it. No window: the field below keeps its value and its
                  focus, and one corrected digit makes the message go away. */}
              {unregistered && (
                <div
                  role="alert"
                  className="mt-[18px] flex flex-col gap-[10px] rounded-[12px] bg-[#FEF4E2] px-[14px] py-[12px] text-[14px] leading-[1.5] text-[#A15C07]"
                >
                  <div className="flex gap-[10px]">
                    <TriangleAlert className="mt-[2px] size-[18px] shrink-0" strokeWidth={2} aria-hidden />
                    <span>
                      {'המספר '}
                      <b dir="ltr" className="font-num">{unregistered}</b>
                      {' אינו רשום באף דירה. ייתכן שהוועד עדיין לא עדכן את הפרטים.'}
                    </span>
                  </div>
                  <PortalSupportAction
                    support={support}
                    className={cn(BTN, BTN_SEC)}
                    label="שליחת בקשת הצטרפות"
                    mailSubject={joinRequestSubject(unregistered)}
                    alwaysOpen
                  />
                </div>
              )}

              {error && (
                <div className="mt-[18px] flex flex-col gap-[10px]">
                  <div role="alert" className="flex gap-[10px] rounded-[12px] bg-[#FDECEC] px-[14px] py-[12px] text-[14px] leading-[1.5] text-[#B03A3E]">
                    <CircleAlert className="mt-[2px] size-[18px] shrink-0" strokeWidth={2} aria-hidden />
                    <span>{error}</span>
                  </div>
                  {/* A message that says "פנה לחברת הניהול" gets the way to do
                      it — a lockout here, or a WhatsApp send that failed. */}
                  {pointsAtManagementCompany(error) && (
                    <PortalSupportAction support={support} className={cn(BTN, BTN_SEC)} />
                  )}
                </div>
              )}

              {/* Mobile: pinned to the bottom of the sheet. Desktop: in flow. */}
              <div className="mt-auto flex flex-col gap-[6px] pt-[16px] pb-[12px] min-[601px]:mt-0 min-[601px]:gap-0 min-[601px]:p-0">
                <Button
                  type="submit"
                  disabled={busy || cooldown > 0}
                  className="h-[54px] w-full gap-[10px] rounded-[14px] text-[17px] min-[601px]:mt-[28px] min-[601px]:h-[48px] min-[601px]:gap-[8px] min-[601px]:rounded-[11px] min-[601px]:px-[18px] min-[601px]:text-[16px]"
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
                <p className="flex items-center justify-center gap-[8px] pb-[4px] text-[12.5px] leading-[normal] text-[#64748B] min-[601px]:mt-[32px] min-[601px]:justify-start min-[601px]:gap-[10px] min-[601px]:rounded-[11px] min-[601px]:bg-[#F5F7FB] min-[601px]:px-[14px] min-[601px]:py-[12px] min-[601px]:text-[13px]">
                  <ShieldCheck className="size-[15px] shrink-0 [stroke-width:2] min-[601px]:size-[18px] min-[601px]:[stroke-width:1.8]" aria-hidden />
                  הגישה מוגבלת לבעלי דירות רשומים בבניין
                </p>
              </div>
        </form>
        ) : (
          <PortalOtpStep
            sentPhone={sentPhone}
            phoneDisplay={formatPhoneForDisplay(prefix, phone)}
            initialCooldown={cooldown}
            support={support}
            onBack={backToPhone}
            onNotRegistered={notRegisteredFromCodeStep}
            onRequestCode={requestCode}
          />
        )}
      </section>
    </div>
  );
}
