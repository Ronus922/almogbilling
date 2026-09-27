import { redirect } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { getPortalSession } from '@/lib/portal/session';
import { PortalLoginForm } from '@/components/portal/PortalLoginForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /portal/login — the only page under /portal that does NOT need a session.
// An owner who already has one is bounced to the portal itself, mirroring what
// the middleware does for the staff login.
//
// Layout: the staff login's single-card shape (DESIGN.md §18) reduced to one
// column — there is no Google button, no "remember me" and no password to
// recover, so a second brand column would be decoration. Mobile-first: the card
// fills the screen under sm and centres from there up.
export default async function PortalLoginPage() {
  if (await getPortalSession()) redirect('/portal');

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-[radial-gradient(130%_130%_at_100%_0%,#eef2f9_0%,#e8edf6_45%,#f6f8fb_100%)] p-5 sm:p-10">
      <div className="w-full max-w-md overflow-hidden rounded-[26px] bg-white p-6 shadow-[0_30px_80px_-20px_rgba(15,42,99,0.35),0_8px_24px_rgba(15,23,42,0.06)] sm:p-10">
        <div className="mb-7 flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-gradient-to-br from-brand to-brand-dark text-white">
            <Building2 className="h-[22px] w-[22px]" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-extrabold leading-tight text-ink">מגדלי חוף הכרמל</span>
            <span className="block truncate text-xs text-ink-3">בניין אלמוג</span>
          </span>
        </div>
        <PortalLoginForm />
      </div>
    </div>
  );
}
