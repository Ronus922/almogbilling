import type { ReactNode } from 'react';
import {
  getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentOverview, getResidentPeriodData,
} from '@/lib/db/finance/portal';
import { countContacts } from '@/lib/db/contacts';
import { listPublishedDecisions } from '@/lib/db/portalDecisions';
import { toDecisionPortalView } from '@/lib/decisionsView';
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
import type { PortalSupport } from './PortalSupportAction';
import { PortalSoon } from './PortalSoon';
import { PortalDecisions } from './PortalDecisions';
import { ReportsIcon } from './PortalIcons';

// The resident's screen, as a server component: picks the tab from the URL,
// loads ONLY that tab's data — every figure from portal.ts with publishedOnly
// (the "published" predicate is in the SQL), the account from the caller —
// and renders the shell around it.
//
// Two callers, one screen:
//   • /portal (the owner): the session decides the identity and the account;
//   • /finance?view=resident (the admin preview): the staff route decides the
//     apartment and passes `preview`, which hides the logout button and keeps
//     the category trend from asking the portal API (no portal session). Nothing
//     in here reads a cookie, so the same rendering cannot differ by caller.
//
// The URL vocabulary — `tab`, `m` (the transactions tab's period, in any of
// the four grammars of lib/finance/period), `r` (range of the reports tab),
// `n` (overview span), `f` (transactions filter) — is not trusted:
// residentPeriodFor() sends a period residents may not open back to the newest
// published month, and a range not in the reports list to the newest range.

export interface PortalScreenParams {
  tab?: string;
  m?: string;
  r?: string;
  n?: string;
  f?: string;
}

export async function PortalScreen({ params, user, accounts, support, preview = false }: {
  params: PortalScreenParams;
  user: PortalUser;
  /** The owner's account(s) — the dark card and "החשבון שלי". */
  accounts: PortalAccount[];
  /** NEXT_PUBLIC_PORTAL_SUPPORT_PHONE / _EMAIL, resolved by the caller: the
   *  account tab's empty state tells the resident to ring the management
   *  company, so it shows them how. */
  support: PortalSupport;
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
      const period = nothing ? null : residentPeriodFor(params.m, publishedMonths);
      if (!period) { body = nothingPublished; break; }
      const data = await getResidentPeriodData(period.from, period.to);
      body = <PortalTransactions key={period.key} period={period} publishedMonths={publishedMonths} data={data} filter={parseTxFilter(params.f)} preview={preview} />;
      break;
    }
    case 'rep': {
      const ranges = reportRanges(publishedMonths);
      const range = reportRangeFor(params.r, ranges);
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
      body = <PortalAccountView accounts={accounts} support={support} />;
      break;
    case 'dec': {
      // Published only — the predicate is inside listPublishedDecisions(), the
      // same discipline the finance tabs follow with portal.ts.
      const decisions = await listPublishedDecisions();
      body = <PortalDecisions decisions={decisions.map(toDecisionPortalView)} />;
      break;
    }
  }

  return (
    <PortalShell tab={tab} apartments={apartments} user={user} preview={preview}>
      {body}
    </PortalShell>
  );
}
