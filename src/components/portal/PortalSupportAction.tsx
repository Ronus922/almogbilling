'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Mail, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSupportPhone, supportMailtoHref, supportTelHref } from '@/lib/portal/support';

/** Both details, as resolved on the server. Either may be null. */
export interface PortalSupport {
  phone: string | null;
  email: string | null;
}

/**
 * "פנייה לחברת הניהול" — the action offered wherever the portal's own copy
 * sends the resident to the management company: the OTP lock screens
 * (ref/otp-states.md, states 12 / 14 / 16), the phone step's error banner and
 * the account tab's empty state.
 *
 * It behaves differently by device, deliberately:
 *   • phone (< 601px)  — a tel: link that opens the dialler, one tap;
 *   • desktop (≥ 601)  — tapping "call" does nothing on a desktop, so the
 *     button REVEALS the number and the address, each copyable in one click.
 *
 * The split is pure CSS (the portal's own 601px breakpoint, same as the
 * buttons around it) rather than a user-agent or a media-query hook: both
 * variants render identically on the server and after hydration, and the one
 * that is `display:none` is out of the accessibility tree as well.
 *
 * `mailSubject` turns it into a pre-addressed message — state 16's "שליחת
 * בקשת הצטרפות", which had no destination at all until 29/09/2026. The subject
 * rides on the mailto: of the address row (and on the mobile link when no
 * number is configured); nothing here builds a form.
 *
 * `alwaysOpen` drops the desktop toggle and shows the two details at once.
 * It is what an INLINE message wants (state 16 since 30/09/2026): the message
 * is already the answer to "what do I do now", and hiding the answer behind a
 * second click inside it would be one click too many. The lock sheets keep the
 * toggle, where the button is the action and the details are the fallback.
 *
 * With neither detail configured the component renders NOTHING — the callers
 * simply get no action, instead of a button that reaches nobody.
 */
export function PortalSupportAction({
  support,
  className,
  label = 'פנייה לחברת הניהול',
  mailSubject,
  alwaysOpen = false,
}: {
  support: PortalSupport;
  /** The caller's button classes — the portal's flat BTN set, or the skin's
   *  own `pbtn` family inside /portal. */
  className: string;
  label?: string;
  /** Subject line for the address row's mailto:, e.g. a join request. */
  mailSubject?: string;
  /** Desktop: show the details straight away instead of behind the button. */
  alwaysOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const phoneDisplay = formatSupportPhone(support.phone);
  const tel = supportTelHref(support.phone);
  const email = support.email?.trim() || null;
  const mailto = supportMailtoHref(email, mailSubject);

  if (!phoneDisplay && !email) return null;

  return (
    <>
      {/* Phone: straight to the dialler (or the mail app when only an address
          is configured). */}
      {tel ? (
        <a href={tel} className={cn(className, 'min-[601px]:hidden')}>{label}</a>
      ) : (
        <a href={mailto ?? '#'} className={cn(className, 'min-[601px]:hidden')}>{label}</a>
      )}

      {/* Desktop: reveal the details in place. */}
      <div className="hidden w-full flex-col gap-[8px] min-[601px]:flex">
        {!alwaysOpen && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={className}
          >
            {label}
          </button>
        )}
        {(open || alwaysOpen) && (
          <div className="flex w-full flex-col gap-[6px] rounded-[12px] bg-[#F5F7FB] p-[10px]">
            {phoneDisplay && (
              <DetailRow icon={<Phone className="size-[15px]" aria-hidden />} value={phoneDisplay} copy={phoneDisplay} numeric />
            )}
            {email && (
              <DetailRow
                icon={<Mail className="size-[15px]" aria-hidden />}
                value={email}
                copy={email}
                // Only when there is something to say: a bare mailto: adds
                // nothing the address itself does not already offer.
                href={mailSubject ? mailto : null}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One detail line. Click anywhere on it to copy, with a two-second receipt —
 *  and, when the row has an `href`, the value itself opens the mail app while
 *  copying moves to its own button beside it (a button inside an anchor is not
 *  valid HTML, so the row splits rather than nests). */
function DetailRow({ icon, value, copy, numeric = false, href = null }: {
  icon: React.ReactNode;
  value: string;
  copy: string;
  numeric?: boolean;
  href?: string | null;
}) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(copy);
      setDone(true);
    } catch {
      // No clipboard permission (or an insecure context) — the value is on
      // screen and selectable, which is the whole point of showing it.
    }
  }

  const body = (
    <>
      <span className="flex items-center gap-[8px] text-[#64748B]">{icon}</span>
      <span dir="ltr" className={cn('min-w-0 flex-1 truncate text-start', numeric && 'font-num')}>{value}</span>
    </>
  );
  const shell = 'flex min-h-[44px] items-center gap-[10px] rounded-[10px] bg-white px-[12px] text-[15px] font-semibold text-[#0F172A] transition-colors hover:bg-[#EEF2FF]';
  const receipt = (
    <span className="flex items-center gap-[6px] text-[13px] font-semibold text-[#64748B]">
      {done ? <Check className="size-[15px] text-[#12A150]" aria-hidden /> : <Copy className="size-[15px]" aria-hidden />}
      {done ? 'הועתק' : 'העתקה'}
    </span>
  );

  if (href) {
    return (
      <div className="flex w-full items-center gap-[6px]">
        <a href={href} className={cn(shell, 'min-w-0 flex-1 justify-between')}>{body}</a>
        <button
          type="button"
          onClick={() => void onCopy()}
          className={cn(shell, 'shrink-0')}
          title={done ? 'הועתק' : 'העתקה'}
        >
          {receipt}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className={cn(shell, 'w-full justify-between')}
      title={done ? 'הועתק' : 'העתקה'}
    >
      {body}
      {receipt}
    </button>
  );
}
