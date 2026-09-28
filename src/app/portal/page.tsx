import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/portal/session';
import { findOwnerIdentity } from '@/lib/db/portal/ownerPhones';
import { getPortalMyAccount } from '@/lib/db/portal/account';
import { PortalScreen } from '@/components/portal/PortalScreen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Param = string | string[] | undefined;
type SearchParams = Promise<{ tab?: Param; m?: Param; r?: Param; n?: Param; f?: Param }>;

const one = (v: Param) => (Array.isArray(v) ? v[0] : v);

// /portal — what a signed-in owner sees (design: ref/Tenant Portal.html).
//   • the gate is getPortalSession(), which ALSO re-checks on every request that
//     the phone is still an active owner — a sold apartment loses access here,
//     with no manual step;
//   • the identity (name, apartments) comes from the roster for the session's
//     phone, and the account from getPortalMyAccount(session) — no parameter
//     of this request can point either at another apartment;
//   • the ONLY finance source is portal.ts with publishedOnly = true (inside
//     PortalScreen). No admin query runs on this page at all.
export default async function PortalPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getPortalSession();
  if (!session) redirect('/portal/login');

  const sp = await searchParams;
  const [identity, accounts] = await Promise.all([
    findOwnerIdentity(session.phoneE164, { onlyActive: true }),
    getPortalMyAccount(session),
  ]);

  return (
    <PortalScreen
      params={{ tab: one(sp.tab), m: one(sp.m), r: one(sp.r), n: one(sp.n), f: one(sp.f) }}
      user={{ name: identity?.ownerName ?? null, apartments: identity?.apartmentNumbers ?? [] }}
      accounts={accounts}
    />
  );
}
