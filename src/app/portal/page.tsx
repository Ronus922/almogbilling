import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/portal/session';
import { findOwnerIdentity } from '@/lib/db/portal/ownerPhones';
import { countContacts } from '@/lib/db/contacts';
import {
  getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData, getResidentOverview,
} from '@/lib/db/finance/portal';
import { monthKeyParts, parsePeriod } from '@/lib/finance/period';
import { publishedMonthKeys, residentPeriodFor } from '@/lib/finance/resident';
import {
  firstName, parseOverviewSpan, parsePortalTab, parseTxFilter, reportRangeFor, reportRanges,
} from '@/lib/portal/ui';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalOverview } from '@/components/portal/PortalOverview';
import { PortalTransactions } from '@/components/portal/PortalTransactions';
import { PortalReports } from '@/components/portal/PortalReports';
import { PortalFundView } from '@/components/portal/PortalFundView';
import { PortalSoon } from '@/components/portal/PortalSoon';
import { AccountIcon, DecisionsIcon, ReportsIcon } from '@/components/portal/PortalIcons';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Param = string | string[] | undefined;
type SearchParams = Promise<{ tab?: Param; m?: Param; r?: Param; n?: Param; f?: Param }>;

const one = (v: Param) => (Array.isArray(v) ? v[0] : v);

// /portal — what a signed-in owner sees (design: ref/Tenant Portal.html).
//   • the gate is getPortalSession(), which ALSO re-checks on every request that
//     the phone is still an active owner — a sold apartment loses access here,
//     with no manual step;
//   • the ONLY data source is portal.ts with publishedOnly = true. No admin
//     query runs on this page at all, so a hidden month, a supplier name or a
//     receipt (while the switch is off) has no path to the browser.
// The active tab and its selections live in the URL — `tab`, `m` (month of
// the transactions tab), `r` (range of the reports tab), `n` (overview span),
// `f` (transactions filter) — so a refresh lands on the same screen. Only the
// active tab's data is loaded. `m` and `r` are not trusted: a month that is
// not published falls back to the newest published one, a range not in the
// list to the newest range.
export default async function PortalPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getPortalSession();
  if (!session) redirect('/portal/login');

  const sp = await searchParams;
  const m = one(sp.m);
  const tab = parsePortalTab(one(sp.tab), m);

  const [identity, apartments, publishedRows] = await Promise.all([
    findOwnerIdentity(session.phoneE164, { onlyActive: true }),
    countContacts(),
    getPublishedMonths(),
  ]);
  const publishedMonths = publishedMonthKeys(publishedRows);
  const nothing = publishedMonths.length === 0;

  const nothingPublished = (
    <PortalSoon icon={<ReportsIcon />} title="עוד לא פורסמו חודשים" text="הדוחות יוצגו כאן ברגע שחברת הניהול תפרסם אותם." />
  );

  let body: ReactNode;
  switch (tab) {
    case 'ov': {
      const overview = nothing ? null : await getResidentOverview(12);
      body = overview
        ? <PortalOverview overview={overview} span={parseOverviewSpan(one(sp.n))} greeting={firstName(identity?.ownerName ?? null)} />
        : nothingPublished;
      break;
    }
    case 'tx': {
      if (nothing) { body = nothingPublished; break; }
      const period = residentPeriodFor(m, publishedMonths);
      const monthKey = period?.kind === 'month' ? period.key : publishedMonths[0];
      const mp = monthKeyParts(monthKey);
      const data = await getResidentMonthData(mp.year, mp.month);
      body = <PortalTransactions key={monthKey} monthKey={monthKey} publishedMonths={publishedMonths} data={data} filter={parseTxFilter(one(sp.f))} />;
      break;
    }
    case 'rep': {
      const ranges = reportRanges(publishedMonths);
      // An old `?m=2026-Q3` link (the previous picker) still opens its report.
      const requested = one(sp.r) ?? (m && parsePeriod(m)?.kind !== 'month' ? m : undefined);
      const range = reportRangeFor(requested, ranges);
      const report = range ? await getPeriodReport(range.from, range.to, { publishedOnly: true }) : null;
      body = <PortalReports key={range?.key ?? 'none'} ranges={ranges} range={range} report={report} />;
      break;
    }
    case 'fund': {
      const fund = nothing ? null : await getResidentFundKpis();
      body = <PortalFundView fund={fund} />;
      break;
    }
    case 'acc':
      body = <PortalSoon icon={<AccountIcon />} title="החשבון שלי" text="כאן תוכלו לראות את מצב החשבון האישי, הכרטסת והקבלות שלכם." />;
      break;
    case 'dec':
      body = <PortalSoon icon={<DecisionsIcon size={28} />} title="החלטות ועד" text="בקרוב תוכלו להצביע על החלטות, לצפות בפרוטוקולים ולאשר את תקציב הבניין — ישירות מכאן." />;
      break;
  }

  return (
    <PortalShell
      tab={tab}
      apartments={apartments}
      user={{ name: identity?.ownerName ?? null, apartments: identity?.apartmentNumbers ?? [] }}
    >
      {body}
    </PortalShell>
  );
}
