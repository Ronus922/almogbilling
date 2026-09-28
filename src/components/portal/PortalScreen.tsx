import type { ReactNode } from 'react';
import {
  getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData, getResidentOverview,
} from '@/lib/db/finance/portal';
import { countContacts } from '@/lib/db/contacts';
import { monthKeyParts, parsePeriod } from '@/lib/finance/period';
import { publishedMonthKeys, residentPeriodFor } from '@/lib/finance/resident';
import {
  firstName, parseOverviewSpan, parsePortalTab, parseTxFilter, reportRangeFor, reportRanges,
} from '@/lib/portal/ui';
import type { PortalAccount } from '@/lib/types/portal';
import { PortalShell, type PortalUser } from './PortalShell';
import { PortalOverview } from './PortalOverview';
import { PortalTransactions } from './PortalTransactions';
import { PortalReports } from './PortalReports';
import { PortalFundView } from './PortalFundView';
import { PortalAccountView } from './PortalAccount';
import { PortalSoon } from './PortalSoon';
import { DecisionsIcon, ReportsIcon } from './PortalIcons';

// The resident's screen, as a server component: picks the tab from the URL,
// loads ONLY that tab's data — every figure from portal.ts with publishedOnly
// (the "published" predicate is in the SQL), the account from the caller —
// and renders the shell around it.
//
// Two callers, one screen:
//   • /portal (the owner): the session decides the identity and the account;
//   • /finance?view=resident (the admin preview): the staff route decides the
//     apartment and passes `preview`, which hides the logout button. Nothing
//     in here reads a cookie, so the same rendering cannot differ by caller.
//
// The URL vocabulary — `tab`, `m` (month of the transactions tab), `r` (range
// of the reports tab), `n` (overview span), `f` (transactions filter) — is not
// trusted: an unpublished month falls back to the newest published one, a
// range not in the list to the newest range.

export interface PortalScreenParams {
  tab?: string;
  m?: string;
  r?: string;
  n?: string;
  f?: string;
}

export async function PortalScreen({ params, user, accounts, preview = false }: {
  params: PortalScreenParams;
  user: PortalUser;
  /** The owner's account(s) — the dark card and "החשבון שלי". */
  accounts: PortalAccount[];
  preview?: boolean;
}) {
  const tab = parsePortalTab(params.tab, params.m);
  const [apartments, publishedRows] = await Promise.all([countContacts(), getPublishedMonths()]);
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
        ? <PortalOverview overview={overview} span={parseOverviewSpan(params.n)} greeting={firstName(user.name)} accounts={accounts} />
        : nothingPublished;
      break;
    }
    case 'tx': {
      if (nothing) { body = nothingPublished; break; }
      const period = residentPeriodFor(params.m, publishedMonths);
      const monthKey = period?.kind === 'month' ? period.key : publishedMonths[0];
      const mp = monthKeyParts(monthKey);
      const data = await getResidentMonthData(mp.year, mp.month);
      body = <PortalTransactions key={monthKey} monthKey={monthKey} publishedMonths={publishedMonths} data={data} filter={parseTxFilter(params.f)} />;
      break;
    }
    case 'rep': {
      const ranges = reportRanges(publishedMonths);
      // An old `?m=2026-Q3` link (the previous picker) still opens its report.
      const requested = params.r ?? (params.m && parsePeriod(params.m)?.kind !== 'month' ? params.m : undefined);
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
      body = <PortalAccountView accounts={accounts} />;
      break;
    case 'dec':
      body = <PortalSoon icon={<DecisionsIcon size={28} />} title="החלטות ועד" text="בקרוב תוכלו להצביע על החלטות, לצפות בפרוטוקולים ולאשר את תקציב הבניין — ישירות מכאן." />;
      break;
  }

  return (
    <PortalShell tab={tab} apartments={apartments} user={user} preview={preview}>
      {body}
    </PortalShell>
  );
}
