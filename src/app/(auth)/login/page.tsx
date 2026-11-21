import { Suspense } from 'react';
import { LoginBrandPanel } from '@/components/auth/LoginBrandPanel';
import { LoginForm } from '@/components/auth/LoginForm';
import { redirectIfSignedIn } from '@/lib/auth/signedIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Login screen — single rounded card: brand panel (right, RTL) + form (left).
// On <lg the brand panel collapses and the form fills the card.
// A visitor who is really signed in goes home; a dead cookie gets the form
// (21/11/2026 — the proxy no longer decides this, see src/proxy.ts).
export default async function LoginPage() {
  await redirectIfSignedIn();
  return (
    <div
      dir="rtl"
      className="flex min-h-dvh w-full items-center justify-center bg-[radial-gradient(130%_130%_at_100%_0%,#eef2f9_0%,#e8edf6_45%,#f6f8fb_100%)] p-5 sm:p-10"
    >
      <div className="flex w-full max-w-5xl overflow-hidden rounded-[26px] bg-white shadow-[0_30px_80px_-20px_rgba(15,42,99,0.35),0_8px_24px_rgba(15,23,42,0.06)] lg:min-h-[600px]">
        <LoginBrandPanel />
        <div className="flex flex-1 items-center justify-center p-8 sm:p-12 lg:p-14">
          <div className="w-full max-w-sm">
            <Suspense fallback={null}>
              <LoginForm />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
