import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { requirePortalFinanceAccess } from '@/lib/portal/session';
import {
  getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData,
} from '@/lib/db/finance/portal';
import { monthKeyParts } from '@/lib/finance/period';
import { publishedMonthKeys, residentPeriodFor } from '@/lib/finance/resident';

export const runtime = 'nodejs';

// GET /api/portal/finance/period?tab=operating|fund&m=YYYY-MM|YYYY-Qn|YYYY-Hn|YYYY
//
// The resident data set for one period — AGGREGATES ONLY. Every figure comes from
// src/lib/db/finance/portal.ts with publishedOnly = true, where the "published"
// predicate lives inside each query: a hidden month yields no rows even if this
// route forgot to check, and supplier names, invoice numbers, internal notes and
// files never leave that module. Read-only; guarded by requirePortalFinanceAccess
// (a live session whose phone is not a blocked phone — 403 otherwise).
//
// `m` is not trusted: residentPeriodFor() falls back to the newest published
// month for anything unparseable or not open to residents, so a hand-crafted
// query string cannot reach a hidden month.
export async function GET(req: Request) {
  try {
    await requirePortalFinanceAccess();

    const url = new URL(req.url);
    const tab = url.searchParams.get('tab') === 'fund' ? 'fund' : 'operating';
    const publishedMonths = publishedMonthKeys(await getPublishedMonths());
    const period = residentPeriodFor(url.searchParams.get('m') ?? undefined, publishedMonths);

    if (!period) {
      return NextResponse.json({ tab, period: null, publishedMonths, monthData: null, report: null, fund: null });
    }

    const isMonth = tab === 'operating' && period.kind === 'month';
    const mp = monthKeyParts(period.key);
    const [monthData, report, fund] = await Promise.all([
      isMonth ? getResidentMonthData(mp.year, mp.month) : Promise.resolve(null),
      tab === 'operating' && period.kind !== 'month'
        ? getPeriodReport(period.from, period.to, { publishedOnly: true })
        : Promise.resolve(null),
      tab === 'fund' ? getResidentFundKpis() : Promise.resolve(null),
    ]);

    return NextResponse.json({ tab, period, publishedMonths, monthData, report, fund });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
