import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The portal's inline amber notice (ref/otp-states.md, state 16): an icon, one
 * message, and under it the way to act on it — usually PortalSupportAction
 * with `alwaysOpen`. Shared by the login's "המספר אינו רשום" and the
 * "we are updating your account" screen of a mixed-owners phone
 * (containment 03/10/2026), so both read as the same kind of message.
 */
export function PortalWarnNotice({ children, action, className }: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-[10px] rounded-[12px] bg-[#FEF4E2] px-[14px] py-[12px] text-[14px] leading-[1.5] text-[#A15C07]',
        className,
      )}
    >
      <div className="flex gap-[10px]">
        <TriangleAlert className="mt-[2px] size-[18px] shrink-0" strokeWidth={2} aria-hidden />
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}
