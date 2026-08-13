import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasAnyAccess } from '@/lib/permissions/check';
import { homePathFor } from '@/lib/auth/home';
import { Card } from '@/components/ui/card';
import { NoAccessCard } from '@/components/auth/NoAccessCard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Landing for an authenticated principal that holds ZERO permissions. Lives in
// the (auth) group — outside the (app) layout whose zero-access guard points
// here, and off the middleware matcher — so it can never join a redirect loop.
export default async function NoAccessPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // A principal with any real access has no business here — send them home.
  if (hasAnyAccess(actor.role, actor.permissions)) redirect(homePathFor(actor.role));

  return (
    <div className="auth-gradient flex min-h-dvh w-full items-center justify-center px-4 py-10 md:px-12">
      <Card className="w-full max-w-md p-8 md:p-10 shadow-xl">
        <NoAccessCard fullName={actor.full_name} />
      </Card>
    </div>
  );
}
