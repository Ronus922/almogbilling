import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasAnyAccess } from '@/lib/permissions/check';
import { deleteSession, getActiveSessionId } from '@/lib/auth/session';
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
    // Distinguish "no session at all" from "session exists but user disabled".
    const sid = await getActiveSessionId();
    if (sid) {
      await deleteSession();
      redirect('/login?reason=disabled');
    }
    redirect('/login');
  }

  // Authenticated but zero permissions (matrix role with no rows): sending them
  // to /login loops (middleware bounces authed users back via `/`). /no-access
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
