import { redirect } from 'next/navigation';
import { env } from '@/env';
import { getPortalSession } from '@/lib/portal/session';
import { resolvePortalIdentity } from '@/lib/db/portal/identity';
import { getPortalMyAccount } from '@/lib/db/portal/account';
import { countContacts } from '@/lib/db/contacts';
import { PortalScreen } from '@/components/portal/PortalScreen';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalAccountReview } from '@/components/portal/PortalAccountReview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Param = string | string[] | undefined;
type SearchParams = Promise<{ tab?: Param; m?: Param; r?: Param; n?: Param; f?: Param }>;

const one = (v: Param) => (Array.isArray(v) ? v[0] : v);

// /portal — what a signed-in owner sees (design: ref/Tenant Portal.html).
//   • the gate is getPortalSession(), which ALSO re-checks on every request that
//     the phone is still an active owner — a sold apartment loses access here,
//     with no manual step;
//   • the identity (name, apartments, the role in each) is the portal's ONE
//     identity for the session's phone (lib/portal/identity.ts), and the
//     account comes from getPortalMyAccount(session) — no parameter of this
//     request can point either at another apartment;
//   • the ONLY finance source is portal.ts with publishedOnly = true (inside
//     PortalScreen). No admin query runs on this page at all;
//   • a BLOCKED phone — several names and no approved identity, or a
//     nameless record among several apartments — gets NONE of it: no tab, no
//     figure, no name (the header says "שלום"), no apartment; only the "we are
//     updating your account" notice with the management company's details,
//     and the fault report button.
export default async function PortalPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getPortalSession();
  if (!session) redirect('/portal/login');

  const support = {
    phone: env.NEXT_PUBLIC_PORTAL_SUPPORT_PHONE ?? null,
    email: env.NEXT_PUBLIC_PORTAL_SUPPORT_EMAIL ?? null,
  };
  const identity = await resolvePortalIdentity(session.phoneE164);

  if (!identity || identity.status !== 'ok') {
    return (
      <PortalShell tab="ov" apartments={await countContacts()} user={{ name: null, apartments: [] }} restricted>
        <PortalAccountReview support={support} />
      </PortalShell>
    );
  }

  const sp = await searchParams;
  const accounts = await getPortalMyAccount(session);

  return (
    <PortalScreen
      params={{ tab: one(sp.tab), m: one(sp.m), r: one(sp.r), n: one(sp.n), f: one(sp.f) }}
      user={{
        name: identity.name,
        apartments: identity.apartments.map((a) => ({ number: a.apartmentNumber, role: a.role })),
      }}
      accounts={accounts}
      support={support}
    />
  );
}
