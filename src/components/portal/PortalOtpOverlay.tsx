'use client';

import { CircleAlert, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PortalSupportAction, type PortalSupport } from '@/components/portal/PortalSupportAction';
import { BTN, BTN_GHOST, BTN_ON, BTN_SEC } from './portalButtons';

// States 14 and 15 of ref/otp-states.md — the two windows. A window is used
// only where the error BLOCKS the flow; everything softer is a message under
// the code boxes. The lock sheet is deliberately not dismissible by its
// backdrop, the system-error dialog is.
//
// State 16 ("המספר לא מזוהה") was a third window here for one day. Ronen took
// it out on 30/09/2026: an unregistered number is almost always a typo, and a
// window that has to be dismissed before the number can be corrected stands
// between the person and the only thing they came to do. It is now an inline
// message under the phone field (PortalLoginForm), with the management
// company's details open inside it — and it is the ONLY presentation of that
// answer, whichever step produced it.

export type PortalOtpOverlayKind =
  | { kind: 'lock' }
  | { kind: 'server'; code: string };

/** mm:ss for a lockout, which can run to 24 hours — the reference's 29:48. */
export function formatLock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const rest = sec % 3600;
  const body = `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`;
  return h > 0 ? `${h}:${body}` : body;
}

export function PortalOtpOverlay({
  overlay, lockLeft = 0, support, onChangeNumber, onRetry, onClose,
}: {
  overlay: PortalOtpOverlayKind;
  /** Seconds left on the lockout — only the 'lock' window reads it. */
  lockLeft?: number;
  support: PortalSupport;
  onChangeNumber: () => void;
  /** Only the 'server' window retries; the others never call it. */
  onRetry?: () => void;
  onClose: () => void;
}) {
  const dismissible = overlay.kind !== 'lock';
  const centred = overlay.kind === 'server';
  return (
    <div
      className={cn(
        'fixed inset-0 z-[70] flex bg-[rgba(15,23,42,.5)]',
        centred ? 'items-center justify-center px-[20px]' : 'flex-col justify-end',
      )}
      onClick={dismissible ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={overlay.kind === 'lock' ? 'הכניסה נחסמה זמנית' : 'משהו השתבש'}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex w-full flex-col items-center gap-[6px] bg-white text-center',
          centred
            ? 'max-w-[400px] rounded-[20px] px-[20px] pt-[24px] pb-[16px] shadow-[0_20px_50px_rgba(15,23,42,.3)]'
            : 'mx-auto max-w-[480px] rounded-t-[24px] px-[24px] pt-[10px] pb-[max(18px,env(safe-area-inset-bottom))]',
        )}
      >
        {!centred && <span aria-hidden className="mb-[14px] h-[4px] w-[40px] shrink-0 rounded-[2px] bg-[#CBD5E1]" />}

        <span aria-hidden className="mb-[8px] grid size-[64px] place-items-center rounded-full bg-[#FDECEC] text-[#E5484D]">
          {overlay.kind === 'lock'
            ? <Lock className="size-[30px]" strokeWidth={2} />
            : <CircleAlert className="size-[30px]" strokeWidth={2} />}
        </span>

        {overlay.kind === 'lock' && (
          <>
            <h2 className="text-[20px] font-extrabold text-[#0F172A]">הכניסה נחסמה זמנית</h2>
            <p className="text-[15px] leading-[1.55] text-[#64748B]">הוזן קוד שגוי כמה פעמים ברציפות. מטעמי אבטחה לא ניתן לנסות שוב כרגע.</p>
            <div className="my-[12px] mb-[4px] flex w-full items-baseline justify-between rounded-[14px] bg-[#F5F7FB] p-[12px]">
              <span className="text-[14px] text-[#64748B]">אפשר לנסות שוב בעוד</span>
              <b dir="ltr" className="font-num text-[28px] font-extrabold">{formatLock(lockLeft)}</b>
            </div>
            <div className="mt-[14px] flex w-full flex-col gap-[6px]">
              <PortalSupportAction support={support} className={cn(BTN, BTN_ON)} />
              <button type="button" onClick={onChangeNumber} className={BTN_GHOST}>שינוי מספר</button>
            </div>
          </>
        )}

        {overlay.kind === 'server' && (
          <>
            <h2 className="text-[20px] font-extrabold text-[#0F172A]">משהו השתבש</h2>
            <p className="text-[15px] leading-[1.55] text-[#64748B]">לא הצלחנו לאמת את הקוד כרגע. הקוד שהזנת נשמר, נסו שוב בעוד רגע.</p>
            <span dir="ltr" className="mt-[4px] font-num text-[12.5px] font-medium whitespace-nowrap text-[#94A3B8]">{overlay.code}</span>
            <div className="mt-[14px] flex w-full flex-row-reverse gap-[10px]">
              <button type="button" onClick={onRetry} className={cn(BTN, BTN_ON, 'h-[48px] text-[16px]')}>נסה שוב</button>
              <button type="button" onClick={onClose} className={cn(BTN, BTN_SEC, 'h-[48px] text-[16px]')}>סגירה</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
