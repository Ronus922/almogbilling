import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listEntriesForMonth } from '@/lib/db/finance/entries';
import { listCategories } from '@/lib/db/finance/categories';
import { getDriveConnectionPublic } from '@/lib/db/finance/drive';
import { getMonthStatus, listPublishedMonths } from '@/lib/db/finance/month-status';
import { getPeriodReport, getRenovationFundKpis } from '@/lib/db/finance/portal';
import { listSuppliers } from '@/lib/db/suppliers';
import { monthKeyParts, parsePeriodParam, periodMonthOf } from '@/lib/finance/period';
import { FinancePageClient } from '@/components/finance/FinancePageClient';
import type { FinanceTab } from '@/components/finance/FinanceTabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ m?: string | string[]; tab?: string | string[] }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /finance — the finance transparency module: the operating budget (one month,
// or a quarter / half / year report) and the renovation fund (cumulative).
// Gate: module `finance` (admin / super_admin). Only the active tab's data is
// loaded; a tab or period change is a navigation, so the server re-renders
// and the client mounts fresh (key). The supplier roster is loaded here (like
// tasks/issues do) and searched client-side.
export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'finance', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'finance', 'edit');

  const sp = await searchParams;
  const tab: FinanceTab = one(sp.tab) === 'fund' ? 'fund' : 'operating';
  const period = parsePeriodParam(sp.m);

  const [categories, suppliers, drive, publishedRows] = await Promise.all([
    listCategories({ includeInactive: true }),
    listSuppliers({ status: 'active' }),
    getDriveConnectionPublic(),
    listPublishedMonths(),
  ]);
  const publishedMonths = publishedRows.map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`);

  const isMonth = tab === 'operating' && period.kind === 'month';
  const { year, month } = monthKeyParts(period.from);
  const [entries, monthStatus, report, fund] = await Promise.all([
    isMonth ? listEntriesForMonth(periodMonthOf(period.key), { section: 'operating' }) : Promise.resolve([]),
    isMonth ? getMonthStatus(year, month) : Promise.resolve(null),
    tab === 'operating' && !isMonth ? getPeriodReport(period.from, period.to, { publishedOnly: false }) : Promise.resolve(null),
    tab === 'fund' ? getRenovationFundKpis({ publishedOnly: false }) : Promise.resolve(null),
  ]);

  return (
    <FinancePageClient
      key={`${tab}:${period.key}`}
      tab={tab}
      period={period}
      entries={entries}
      monthStatus={monthStatus}
      report={report}
      fund={fund}
      publishedMonths={publishedMonths}
      categories={categories}
      suppliers={suppliers.map((s) => ({
        id: s.id, display_name: s.display_name, company_name: s.company_name,
        tax_id: s.tax_id, phone: s.phone, mobile: s.mobile,
      }))}
      canEdit={canEdit}
      driveConnected={drive.connected}
    />
  );
}
