import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AuthProvider } from '@/lib/auth/context';
import { AppShell } from '@/components/app-shell/AppShell';
import { TooltipProvider } from '@/components/ui/tooltip';

export const runtime = 'nodejs';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <AuthProvider initialUser={session.user}>
      <TooltipProvider>
        <AppShell>{children}</AppShell>
      </TooltipProvider>
    </AuthProvider>
  );
}
