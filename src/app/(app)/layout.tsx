import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasAnyAccess } from '@/lib/permissions/check';
import { hasSessionCookie } from '@/lib/auth/session';
import { SESSION_RESET_PATH } from '@/lib/constants';
import { AuthProvider } from '@/lib/auth/context';
import { AppShell } from '@/components/app-shell/AppShell';
import { TooltipProvider } from '@/components/ui/tooltip';

export const runtime = 'nodejs';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getCurrentActor();

  if (!actor) {
    // A cookie that names no live session (expired, deleted, or its user
    // disabled) goes to the reset route: a layout cannot modify cookies, the
    // route can — it clears the cookie, tells a disabled user apart
    // (?reason=disabled) and ends on /login. No cookie at all → /login.
    redirect((await hasSessionCookie()) ? SESSION_RESET_PATH : '/login');
  }

  // Authenticated but zero permissions (matrix role with no rows): /login
  // would send them straight back home, into this layout again. /no-access
  // sits outside this layout, so it breaks the cycle.
  if (!hasAnyAccess(actor.role, actor.permissions)) {
    redirect('/no-access');
  }

  const initialActor = {
    id: actor.id,
    username: actor.username,
    email: actor.email,
    full_name: actor.full_name,
    role: actor.role,
    permissions: actor.permissions,
  };

  return (
    <AuthProvider initialActor={initialActor}>
      <TooltipProvider>
        <AppShell>{children}</AppShell>
      </TooltipProvider>
    </AuthProvider>
  );
}
