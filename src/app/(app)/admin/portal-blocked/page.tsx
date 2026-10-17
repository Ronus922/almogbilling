import { redirect } from 'next/navigation';

// /admin/portal-blocked — moved into /contacts as the "זהויות פורטל" section
// (16/10/2026, one place instead of two: PortalIdentitiesSection). /contacts
// re-checks `portal_manage` on arrival, so this redirect carries no gate of
// its own.
export default function AdminPortalBlockedPage() {
  redirect('/contacts');
}
