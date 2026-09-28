import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/portal/session';
import { PortalLoginForm } from '@/components/portal/PortalLoginForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /portal/login — the only page under /portal that does NOT need a session.
// An owner who already has one is bounced to the portal itself, mirroring what
// the middleware does for the staff login.
//
// Layout: the reference screens in ref/proof — tenant-portal-login.md (≥901px:
// brand column 46% on the right + form pane) and tenant-login-mobile.md (≤900px:
// brand hero + white sheet). Both panes are rendered by PortalLoginForm, because
// on mobile the code step replaces the hero with a top bar, and the step is
// client state. Nothing here is shared with the staff /login.
export default async function PortalLoginPage() {
  if (await getPortalSession()) redirect('/portal');

  return <PortalLoginForm />;
}
