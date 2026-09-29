'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Mail, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSupportPhone, supportTelHref } from '@/lib/portal/support';

/** Both details, as resolved on the server. Either may be null. */
export interface PortalSupport {
  phone: string | null;
  email: string | null;
}

/**
 * "פנייה לחברת הניהול" — the one action the OTP lock screens offer when the
 * owner cannot get in (ref/otp-states.md, states 12 / 14 / 16).
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
 * With neither detail configured the component renders NOTHING — the callers
 * simply get no action, instead of a button that reaches nobody.
 */
export function PortalSupportAction({
  support,
  className,
  label = 'פנייה לחברת הניהול',
}: {
  support: PortalSupport;
  /** The caller's button classes — the portal's flat BTN set. */
  className: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const phoneDisplay = formatSupportPhone(support.phone);
  const tel = supportTelHref(support.phone);
  const email = support.email?.trim() || null;

  if (!phoneDisplay && !email) return null;

  return (
    <>
      {/* Phone: straight to the dialler (or the mail app when only an address
          is configured). */}
      {tel ? (
        <a href={tel} className={cn(className, 'min-[601px]:hidden')}>{label}</a>
      ) : (
        <a href={`mailto:${email}`} className={cn(className, 'min-[601px]:hidden')}>{label}</a>
      )}

      {/* Desktop: reveal the details in place. */}
      <div className="hidden w-full flex-col gap-[8px] min-[601px]:flex">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={className}
        >
          {label}
        </button>
        {open && (
          <div className="flex w-full flex-col gap-[6px] rounded-[12px] bg-[#F5F7FB] p-[10px]">
            {phoneDisplay && (
              <CopyRow icon={<Phone className="size-[15px]" aria-hidden />} value={phoneDisplay} copy={phoneDisplay} numeric />
            )}
            {email && (
              <CopyRow icon={<Mail className="size-[15px]" aria-hidden />} value={email} copy={email} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One detail line: click anywhere on it to copy, with a two-second receipt. */
function CopyRow({ icon, value, copy, numeric = false }: {
  icon: React.ReactNode;
  value: string;
  copy: string;
  numeric?: boolean;
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

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="flex min-h-[44px] w-full items-center justify-between gap-[10px] rounded-[10px] bg-white px-[12px] text-[15px] font-semibold text-[#0F172A] transition-colors hover:bg-[#EEF2FF]"
      title={done ? 'הועתק' : 'העתקה'}
    >
      <span className="flex items-center gap-[8px] text-[#64748B]">{icon}</span>
      <span dir="ltr" className={cn('min-w-0 flex-1 truncate text-start', numeric && 'font-num')}>{value}</span>
      <span className="flex items-center gap-[6px] text-[13px] font-semibold text-[#64748B]">
        {done ? <Check className="size-[15px] text-[#12A150]" aria-hidden /> : <Copy className="size-[15px]" aria-hidden />}
        {done ? 'הועתק' : 'העתקה'}
      </span>
    </button>
  );
}
