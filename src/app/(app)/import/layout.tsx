import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { homePathFor } from '@/lib/auth/home';
import { isGuardRole } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

// /import is a client page with no gate of its own — any signed-in role can OPEN
// it (its API routes are what refuse: import:edit). The guard (08/11/2026) has
// one screen and every other page must send it back server-side, so this layout
// does that for the guard and changes nothing for anyone else. Found by the
// page crawl in e2e/visitors.spec.ts. (Whether the other roles should see the
// page at all is a separate question — reported, not decided here.)
export default async function ImportLayout({ children }: { children: React.ReactNode }) {
  const actor = await getCurrentActor();
  if (actor && isGuardRole(actor.role)) redirect(homePathFor(actor.role));
  return children;
}
