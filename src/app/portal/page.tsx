import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/portal/session';
import {
  getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData,
} from '@/lib/db/finance/portal';
import { monthKeyParts } from '@/lib/finance/period';
import { publishedMonthKeys, residentPeriodFor } from '@/lib/finance/resident';
import { PortalHeader } from '@/components/portal/PortalHeader';
import { PortalFinanceView } from '@/components/portal/PortalFinanceView';
import type { FinanceTab } from '@/components/finance/FinanceTabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ m?: string | string[]; tab?: string | string[] }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /portal — what a signed-in owner sees. Mirrors the admin's ?view=resident page
// (src/app/(app)/finance/page.tsx) with two differences that matter:
//   • the gate is getPortalSession(), which ALSO re-checks on every request that
//     the phone is still an active owner — a sold apartment loses access here,
//     with no manual step;
//   • the ONLY data source is portal.ts with publishedOnly = true. No admin query
//     runs on this page at all, so a hidden month, a supplier name or a receipt
//     has no path to the browser.
export default async function PortalPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getPortalSession();
  if (!session) redirect('/portal/login');

  const sp = await searchParams;
  const tab: FinanceTab = one(sp.tab) === 'fund' ? 'fund' : 'operating';

  const publishedMonths = publishedMonthKeys(await getPublishedMonths());
  // Not trusted: an unparseable or unpublished `m` falls back to the newest
  // published month, so a hand-typed query string cannot open a hidden one.
  const period = residentPeriodFor(sp.m, publishedMonths);

  const isMonth = tab === 'operating' && period?.kind === 'month';
  const mp = period ? monthKeyParts(period.key) : null;
  const [monthData, report, fund] = await Promise.all([
    isMonth && mp ? getResidentMonthData(mp.year, mp.month) : Promise.resolve(null),
    tab === 'operating' && period && period.kind !== 'month'
      ? getPeriodReport(period.from, period.to, { publishedOnly: true })
      : Promise.resolve(null),
    tab === 'fund' && period ? getResidentFundKpis() : Promise.resolve(null),
  ]);

  return (
    <>
      <PortalHeader />
      <PortalFinanceView
        key={`portal:${tab}:${period?.key ?? 'none'}`}
        tab={tab}
        period={period}
        publishedMonths={publishedMonths}
        monthData={monthData}
        report={report}
        fund={fund}
      />
    </>
  );
}
