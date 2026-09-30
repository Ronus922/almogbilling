'use client';

import {
  useEffect, useRef, useState,
  type ClipboardEvent, type FormEvent, type KeyboardEvent,
} from 'react';
import {
  CircleAlert, CircleCheck, Info, LoaderCircle, Lock, RefreshCw, TriangleAlert, WifiOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PortalSupportAction, type PortalSupport } from '@/components/portal/PortalSupportAction';
import { formatLock, PortalOtpOverlay, type PortalOtpOverlayKind } from '@/components/portal/PortalOtpOverlay';
import { BTN, BTN_DIS, BTN_GHOST, BTN_OK, BTN_ON, BTN_SEC, LINK } from './portalButtons';
import {
  PORTAL_OTP_DIGITS, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TTL_MINUTES,
  portalLastAttemptMessage,
} from '@/lib/constants/portal';

// /portal/login, step 2 — "הזנת קוד", built to ref/OTP States.html +
// ref/otp-states.md (29/09/2026). All sixteen states of the reference live
// here; which one shows is derived from `phase`, the server's answer and the
// two timers, never set by hand.
//
// Three DECLARED departures from the reference, all of them Ronen's:
//   • Five wrong attempts before a lockout, not three (the reference's 3 is a
//     design-doc value; the system's ceiling is PORTAL_OTP_MAX_ATTEMPTS).
//   • NO SMS. There is no SMS channel in this system, so state 09's
//     "שלח ב-SMS במקום" is not built and the card offers WhatsApp alone.
//   • State 16's "שליחת בקשת הצטרפות" is not built either — no such flow
//     exists — so the sheet offers "הזנת מספר אחר", which does.
//
// THE BUG THIS SCREEN FIXES (29/09/2026): the previous boxes kept their digits
// after a wrong code and auto-submitted on every keystroke of the correction,
// so one honest retype burned four of the five attempts and the resident was
// locked out "after two tries". State 06 of the reference always said what to
// do instead — "הקשה על ספרה כלשהי מרוקנת את התאים" — and that is now what
// happens: after a wrong code the next touch clears every box, and a verify is
// only ever sent for a code the resident actually completed.

const BOXES = Array.from({ length: PORTAL_OTP_DIGITS }, (_, i) => i);

/** Everything the screen can be showing. `error` and `success` describe the
 *  boxes; the overlays are separate because they sit ON TOP of any of them. */
type Phase = 'idle' | 'verifying' | 'error' | 'success' | 'expired' | 'locked';
type Tone = 'err' | 'warn' | 'ok' | 'info';
type Overlay = PortalOtpOverlayKind | null;

interface Msg { tone: Tone; text: string; box?: boolean; icon?: 'wifi' }

export interface OtpRequestOutcome {
  sent: boolean;
  locked?: boolean;
  lockedUntil?: string | null;
  notRegistered?: boolean;
  message?: string;
  retryAfterSec?: number;
}

const TONE_TEXT: Record<Tone, string> = {
  err: 'text-[#B03A3E]',
  warn: 'text-[#A15C07]',
  ok: 'text-[#0B7A3B]',
  info: 'text-[#64748B]',
};
const TONE_BOX: Record<Tone, string> = {
  err: 'bg-[#FDECEC]',
  warn: 'bg-[#FEF4E2]',
  ok: 'bg-[#E7F6EE]',
  info: 'bg-[#F5F7FB]',
};

function ToneIcon({ tone, icon }: { tone: Tone; icon?: 'wifi' }) {
  const cls = 'mt-[2px] size-[18px] shrink-0';
  if (icon === 'wifi') return <WifiOff className={cls} strokeWidth={2} aria-hidden />;
  if (tone === 'ok') return <CircleCheck className={cls} strokeWidth={2} aria-hidden />;
  if (tone === 'warn') return <TriangleAlert className={cls} strokeWidth={2} aria-hidden />;
  if (tone === 'info') return <Info className={cls} strokeWidth={2} aria-hidden />;
  return <CircleAlert className={cls} strokeWidth={2} aria-hidden />;
}

function formatCountdown(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Seconds from now until an ISO deadline. Module scope on purpose: reading
 *  the clock belongs outside the component body. */
function secondsUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

/** A ticking number of seconds that never goes below zero. One interval per
 *  hook, cleared the moment it lands on 0 — no interval survives the state. */
function useCountdown(initial: number): [number, (n: number) => void] {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return [left, setLeft];
}


export function PortalOtpStep({
  sentPhone, phoneDisplay, initialCooldown, support, onBack, onNotRegistered, onRequestCode,
}: {
  /** Exactly the string the request carried — the verify sends the same one. */
  sentPhone: string;
  /** 052-418-7730 — display only. */
  phoneDisplay: string;
  initialCooldown: number;
  /** NEXT_PUBLIC_PORTAL_SUPPORT_PHONE / _EMAIL, resolved on the server. With
   *  neither set the "פנייה לחברת הניהול" action is not drawn at all, rather
   *  than drawing a button that reaches nobody. */
  support: PortalSupport;
  onBack: () => void;
  /** The number stopped being an owner between the request and now. Handed
   *  UP rather than shown here: state 16 is one inline message under the
   *  phone field (30/09/2026), and two presentations of one answer would be
   *  two things to keep in step. */
  onNotRegistered: () => void;
  /** Asks the server for another code. Owned by the parent because the phone
   *  step uses the very same call for the first send. */
  onRequestCode: () => Promise<OtpRequestOutcome>;
}) {
  const [digits, setDigits] = useState<string[]>(() => BOXES.map(() => ''));
  const [rawPhase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useCountdown(initialCooldown);
  const [lockLeft, setLockLeft] = useCountdown(0);
  // The lock lifts by itself the moment its countdown runs out — derived, so
  // no effect has to notice and no state can be left stale.
  const phase: Phase = rawPhase === 'locked' && lockLeft <= 0 ? 'idle' : rawPhase;
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);
  /** Set by a wrong code: the next touch on any box wipes the row (state 06 →
   *  07). This is the whole reason one retype no longer costs four attempts. */
  const clearOnNextTouch = useRef(false);
  /** The last six digits that actually went to the server, so an unchanged
   *  code is never sent twice. State, not a ref: the primary button's enabled
   *  state is derived from it. */
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);

  const code = digits.join('');
  const complete = digits.every((d) => d !== '');
  const busy = phase === 'verifying';
  const inert = busy || phase === 'success' || phase === 'expired' || phase === 'locked';

  useEffect(() => { boxRefs.current[0]?.focus(); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!shake) return;
    const t = setTimeout(() => setShake(false), 800);
    return () => clearTimeout(t);
  }, [shake]);

  function reset() {
    setDigits(BOXES.map(() => ''));
    clearOnNextTouch.current = false;
    setLastSubmitted(null);
  }

  function enterLock(untilIso: string | null | undefined) {
    setPhase('locked');
    setMsg(null);
    setLockLeft(secondsUntil(untilIso));
    setOverlay({ kind: 'lock' });
    setLastSubmitted(null);
  }

  async function submit(value: string) {
    if (inert) return;
    if (value.length !== PORTAL_OTP_DIGITS) return;
    setLastSubmitted(value);
    setPhase('verifying');
    setMsg(null);
    let res: Response;
    try {
      res = await fetch('/api/portal/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: sentPhone, code: value }),
      });
    } catch {
      // 13 — no connection. The digits stay put and the attempt was never made,
      // so it cannot have been counted.
      setPhase('idle');
      setMsg({ tone: 'info', text: 'אין חיבור לאינטרנט. הקוד נשמר, נסו שוב כשהחיבור יחזור.', box: true, icon: 'wifi' });
      setLastSubmitted(null);
      return;
    }
    let data: {
      ok?: boolean; message?: string; attemptsLeft?: number; locked?: boolean;
      lockedUntil?: string | null; expired?: boolean; notRegistered?: boolean;
    } = {};
    try { data = await res.json(); } catch { /* keep {} */ }

    if (data.ok) {
      setPhase('success');
      setMsg({ tone: 'ok', text: 'הקוד אומת. מעבירים אותך לפורטל…' });
      setTimeout(() => window.location.assign('/portal'), 800);
      return;
    }

    // 15 — a server fault. Never counted as a wrong code, and the digits stay.
    if (res.status >= 500) {
      setPhase('idle');
      const now = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
      setOverlay({ kind: 'server', code: `ERR-${res.status} · ${now}` });
      setLastSubmitted(null);
      return;
    }

    if (data.locked) { enterLock(data.lockedUntil); return; }

    if (data.notRegistered) {
      setPhase('idle');
      onNotRegistered();
      return;
    }

    if (data.expired) {
      // 11 — the boxes lock and the primary action becomes "שלח קוד חדש".
      setPhase('expired');
      setMsg({ tone: 'warn', text: data.message ?? 'תוקף הקוד פג. שלחו קוד חדש כדי להמשיך.', box: true });
      setCooldown(0);
      return;
    }

    // 06 / 08 — wrong code. One attempt left turns the red line into the amber
    // warning BEFORE the lockout, so it never arrives as a surprise.
    setPhase('error');
    setShake(true);
    clearOnNextTouch.current = true;
    setMsg(data.attemptsLeft === 1
      ? { tone: 'warn', text: portalLastAttemptMessage(), box: true }
      : { tone: 'err', text: data.message ?? 'הקוד שגוי. נסו שוב.' });
  }

  /** Writes `insert` from `start`, moves focus past the last digit written and
   *  submits once all six are in — but only for a code that differs from the
   *  one already sent. */
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
    if (next.every((d) => d !== '') && joined !== lastSubmitted) {
      void submit(joined);
    }
  }

  /** 06 → 07. The first touch after a wrong code empties every box and turns
   *  the red line into a neutral "type it again · N attempts left", exactly as
   *  the reference describes. Returns the row to write into. */
  function touch(): readonly string[] {
    if (!clearOnNextTouch.current) return digits;
    clearOnNextTouch.current = false;
    const cleared = BOXES.map(() => '');
    setPhase('idle');
    setShake(false);
    setMsg((m) => (m && m.tone === 'err'
      ? { tone: 'info', text: m.text.replace(/^הקוד שגוי\. /, 'הזינו את הקוד מחדש · ').replace(/\.$/, '') }
      : m));
    setDigits(cleared);
    boxRefs.current[0]?.focus();
    return cleared;
  }

  function handleChange(i: number, value: string) {
    if (inert) return;
    const base = touch();
    const wasCleared = base !== digits;
    const typed = value.replace(/\D+/g, '');
    if (!typed) {
      const next = [...base];
      next[i] = '';
      setDigits(next);
      return;
    }
    let insert = typed;
    const existing = base[i];
    if (!wasCleared && existing && typed.length === 2) {
      insert = typed.startsWith(existing) ? typed.slice(1) : typed.slice(0, 1);
    }
    fillFrom(wasCleared ? 0 : i, insert, base);
  }

  function handleKeyDown(i: number, ev: KeyboardEvent<HTMLInputElement>) {
    if (inert) return;
    if (ev.key === 'Backspace' && !digits[i] && i > 0) {
      ev.preventDefault();
      const base = touch();
      const next = [...base];
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

  function handlePaste(i: number, ev: ClipboardEvent<HTMLInputElement>) {
    if (inert) return;
    const pasted = ev.clipboardData.getData('text').replace(/\D+/g, '');
    if (!pasted) return;
    ev.preventDefault();
    const base = touch();
    fillFrom(pasted.length >= PORTAL_OTP_DIGITS ? 0 : i, pasted.slice(0, PORTAL_OTP_DIGITS), base);
  }

  /** 09 → 10. A new code cancels the previous one server-side, which is also
   *  what resets the attempt counter — the boxes start empty again. */
  async function resend() {
    if (resending || cooldown > 0 || phase === 'locked') return;
    setResending(true);
    setMsg(null);
    setOverlay(null);
    try {
      const out = await onRequestCode();
      if (out.sent) {
        reset();
        setPhase('idle');
        setCooldown(PORTAL_OTP_RESEND_COOLDOWN_SEC);
        setToast('קוד חדש נשלח בוואטסאפ');
        boxRefs.current[0]?.focus();
        return;
      }
      if (out.locked) { enterLock(out.lockedUntil); return; }
      if (out.notRegistered) { onNotRegistered(); return; }
      if (typeof out.retryAfterSec === 'number' && out.retryAfterSec > 0) setCooldown(out.retryAfterSec);
      setMsg({ tone: 'err', text: out.message ?? 'שליחת הקוד נכשלה. נסו שוב בעוד רגע.' });
    } catch {
      setMsg({ tone: 'info', text: 'אין חיבור לאינטרנט. נסו שוב כשהחיבור יחזור.', box: true, icon: 'wifi' });
    } finally {
      setResending(false);
    }
  }

  function onSubmitForm(e: FormEvent) {
    e.preventDefault();
    if (phase === 'expired') { void resend(); return; }
    if (phase === 'error') { touch(); return; }
    if (complete && code !== lastSubmitted) void submit(code);
  }

  // ── the primary button, by state ──────────────────────────────────────────
  const primary = (() => {
    if (phase === 'success') {
      return <button type="button" disabled className={cn(BTN, BTN_OK)}><CircleCheck className="size-[20px]" aria-hidden />מחובר</button>;
    }
    if (phase === 'verifying') {
      return <button type="button" disabled className={cn(BTN, BTN_ON, 'opacity-85')}><LoaderCircle className="size-[20px] animate-spin" aria-hidden />מאמת…</button>;
    }
    if (phase === 'expired') {
      return <button type="submit" disabled={resending} className={cn(BTN, BTN_ON)}><RefreshCw className="size-[18px]" aria-hidden />שלח קוד חדש</button>;
    }
    if (phase === 'locked') {
      // 12 — no login button at all. The only actions are contacting the
      // management company and changing the number.
      return <PortalSupportAction support={support} className={cn(BTN, BTN_SEC)} />;
    }
    const ready = complete && code !== lastSubmitted;
    return (
      <button type="submit" disabled={!ready} className={cn(BTN, ready ? BTN_ON : BTN_DIS)}>
        כניסה לפורטל
      </button>
    );
  })();

  const boxTone =
    phase === 'error' ? 'border-[#E5484D] bg-[#FFF8F8] text-[#B03A3E]'
      : phase === 'success' ? 'border-[#12A150] bg-[#E7F6EE] text-[#0B7A3B]'
        : phase === 'expired' || phase === 'locked' ? 'border-[#E2E8F0] bg-[#F1F5F9] text-[#94A3B8]'
          : null;

  return (
    <>
      {toast && (
        <div role="status" className="pointer-events-none fixed inset-x-[12px] top-[12px] z-[60] mx-auto flex max-w-[400px] items-center gap-[10px] rounded-[14px] bg-[#0F172A] px-[14px] py-[12px] text-[14.5px] font-medium text-white shadow-[0_10px_30px_rgba(15,23,42,.25)]">
          <span className="grid size-[24px] shrink-0 place-items-center rounded-full bg-[#12A150]">
            <CircleCheck className="size-[16px]" strokeWidth={2.4} aria-hidden />
          </span>
          {toast}
        </div>
      )}

      <form onSubmit={onSubmitForm} noValidate className="flex w-full flex-1 flex-col min-[601px]:max-w-[400px] min-[601px]:flex-none">
        <h1 className="text-[28px] font-extrabold leading-[normal] text-[#0F172A] min-[601px]:text-[32px]">הזנת קוד</h1>
        <p className="mt-[10px] text-[15.5px] leading-[1.55] text-[#64748B]">שלחנו קוד בן {PORTAL_OTP_DIGITS} ספרות בוואטסאפ למספר</p>
        <div className="mt-[6px] flex items-center gap-[8px]">
          <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[#25D366]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.4A10 10 0 1 0 12 2Zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-1.7-.1a12 12 0 0 1-5.6-4.9c-.4-.7-.9-1.6-.9-2.4 0-.9.5-1.4.7-1.6.2-.2.4-.3.6-.3h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.3.4c-.1.2-.3.3-.1.6.2.3.7 1.2 1.5 1.9 1 .9 1.8 1.1 2 1.2.3.1.4.1.6-.1l.8-.9c.2-.2.3-.2.6-.1l1.6.8c.3.1.4.2.5.3v.9Z"/></svg>
          </span>
          <b dir="ltr" className="font-num text-[17px] font-bold text-[#0F172A]">{phoneDisplay}</b>
        </div>
        <p className="mt-[4px] text-[13.5px] text-[#94A3B8]">הקוד תקף ל-{PORTAL_OTP_TTL_MINUTES} דקות</p>

        <div
          dir="ltr"
          className={cn('mt-[26px] flex justify-between gap-[8px]', shake && 'motion-safe:animate-[portal-otp-shake_0.4s_ease-in-out_2]')}
        >
          {BOXES.map((i) => (
            <input
              key={i}
              ref={(el) => { boxRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={2}
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              aria-label={`ספרה ${i + 1} מתוך ${PORTAL_OTP_DIGITS}`}
              value={digits[i] ?? ''}
              readOnly={inert}
              disabled={phase === 'expired' || phase === 'locked'}
              onChange={(ev) => handleChange(i, ev.target.value)}
              onKeyDown={(ev) => handleKeyDown(i, ev)}
              onPaste={(ev) => handlePaste(i, ev)}
              onFocus={(ev) => { touch(); ev.currentTarget.select(); }}
              className={cn(
                'h-[58px] w-full min-w-0 rounded-[12px] border-[1.5px] text-center font-num text-[26px] font-bold outline-none transition-[border-color,background-color,box-shadow,opacity] duration-150 min-[601px]:h-[56px] min-[601px]:rounded-[11px] min-[601px]:text-[22px]',
                boxTone ?? (digits[i]
                  ? 'border-[#CBD5E1] bg-white text-[#0F172A]'
                  : 'border-[#E2E8F0] bg-[#F5F7FB] text-[#0F172A]'),
                busy && 'opacity-55',
                !inert && 'focus:border-brand focus:bg-white focus:ring-4 focus:ring-[rgba(61,90,254,0.12)]',
              )}
            />
          ))}
        </div>

        {msg && (
          <div
            role={msg.tone === 'err' ? 'alert' : 'status'}
            className={cn(
              'mt-[14px] flex items-start gap-[8px] text-[14.5px] font-medium leading-[1.5]',
              TONE_TEXT[msg.tone],
              msg.box && cn('rounded-[12px] px-[14px] py-[12px]', TONE_BOX[msg.tone]),
            )}
          >
            <ToneIcon tone={msg.tone} icon={msg.icon} />
            <span>{msg.text}</span>
          </div>
        )}

        {/* 12 — the inline lock card, with its own live countdown. */}
        {phase === 'locked' && (
          <div className="mt-[22px] flex flex-col gap-[14px] rounded-[16px] bg-[#FDECEC] p-[18px]">
            <div className="flex items-center gap-[12px]">
              <span aria-hidden className="grid size-[42px] shrink-0 place-items-center rounded-full bg-white text-[#E5484D]">
                <Lock className="size-[20px]" strokeWidth={2} />
              </span>
              <div>
                <b className="block text-[16px] text-[#B03A3E]">יותר מדי ניסיונות שגויים</b>
                <span className="text-[14px] text-[#B03A3E] opacity-85">מטעמי אבטחה הכניסה נחסמה זמנית</span>
              </div>
            </div>
            <div className="flex items-baseline justify-between border-t border-[#F3C1C3] pt-[14px]">
              <span className="text-[14px] text-[#B03A3E]">אפשר לנסות שוב בעוד</span>
              <b dir="ltr" aria-hidden className="font-num text-[32px] font-extrabold text-[#0F172A]">{formatLock(lockLeft)}</b>
              {/* Announced once a minute, not once a second (otp-states.md). */}
              <span className="sr-only" aria-live="polite">{`אפשר לנסות שוב בעוד ${Math.ceil(lockLeft / 60)} דקות`}</span>
            </div>
          </div>
        )}

        {/* 09 — the timer has run out: the resend card replaces it. No SMS. */}
        {phase !== 'locked' && phase !== 'expired' && cooldown === 0 && (
          <div className="mt-[22px] flex flex-col gap-[10px] rounded-[16px] border-[1.5px] border-[#E2E8F0] p-[16px]">
            <div className="text-[15px] font-bold text-[#0F172A]">
              לא קיבלת את הקוד?
              <small className="mt-[2px] block text-[13.5px] font-medium text-[#64748B]">בדקו שוואטסאפ מחובר לאינטרנט</small>
            </div>
            <button
              type="button"
              onClick={() => void resend()}
              disabled={resending || busy}
              className="flex h-[46px] items-center justify-center gap-[8px] rounded-[12px] border-[1.5px] border-brand bg-brand-soft text-[15px] font-semibold text-[#2B3FB8] transition-colors hover:brightness-[0.97] disabled:opacity-60"
            >
              {resending ? <LoaderCircle className="size-[18px] animate-spin" aria-hidden /> : <RefreshCw className="size-[18px]" aria-hidden />}
              שלח שוב בוואטסאפ
            </button>
          </div>
        )}

        {/* The hint row — hidden while locked (state 12 has no resend timer). */}
        {phase !== 'locked' && cooldown > 0 && (
          <div className="mt-[22px] flex items-center justify-between text-[14.5px] text-[#64748B]">
            <button type="button" onClick={onBack} disabled={busy} className={LINK}>שינוי מספר</button>
            <span className="-my-[12px] inline-flex min-h-[44px] items-center gap-[4px] whitespace-nowrap">
              שליחה חוזרת בעוד
              <b dir="ltr" className="font-num font-bold text-[#334155]">{formatCountdown(cooldown)}</b>
            </span>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-[6px] pt-[16px] pb-[12px] min-[601px]:mt-[28px] min-[601px]:p-0">
          {primary}
          {phase === 'locked' && (
            <button type="button" onClick={onBack} className={BTN_GHOST}>שינוי מספר</button>
          )}
        </div>
      </form>

      {overlay && !(overlay.kind === 'lock' && lockLeft <= 0) && (
        <PortalOtpOverlay
          overlay={overlay}
          lockLeft={lockLeft}
          support={support}
          onChangeNumber={onBack}
          onRetry={() => { setOverlay(null); if (complete) void submit(code); }}
          onClose={() => setOverlay(null)}
        />
      )}
    </>
  );
}
