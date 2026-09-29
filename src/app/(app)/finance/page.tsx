import { env } from '@/env';
import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listEntriesForMonth } from '@/lib/db/finance/entries';
import { listCategories } from '@/lib/db/finance/categories';
import { getDriveConnectionPublic } from '@/lib/db/finance/drive';
import { getMonthStatus, listPublishedMonths } from '@/lib/db/finance/month-status';
import { getPeriodReport, getRenovationFundKpis } from '@/lib/db/finance/portal';
import { listApartmentNumbers } from '@/lib/db/contacts';
import { getAdminPreviewAccount } from '@/lib/db/portal/account';
import { listSuppliers } from '@/lib/db/suppliers';
import { monthKeyParts, parsePeriodParam, periodMonthOf } from '@/lib/finance/period';
import { publishedMonthKeys } from '@/lib/finance/resident';
import { FinancePageClient } from '@/components/finance/FinancePageClient';
import { AdminPreviewBar } from '@/components/finance/AdminPreviewBar';
import { PortalScreen } from '@/components/portal/PortalScreen';
import type { FinanceTab } from '@/components/finance/FinanceTabs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Param = string | string[] | undefined;
type SearchParams = Promise<{ m?: Param; tab?: Param; view?: Param; apt?: Param; r?: Param; n?: Param; f?: Param }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /finance — the finance transparency module: the operating budget (one month,
// or a quarter / half / year report) and the renovation fund (cumulative).
// Gate: module `finance` (admin / super_admin). Only the active tab's data is
// loaded; a tab or period change is a navigation, so the server re-renders
// and the client mounts fresh (key). The supplier roster is loaded here (like
// tasks/issues do) and searched client-side.
//
// ?view=resident renders the owners portal itself (PortalScreen, the same
// components /portal mounts) in read-only preview, with an admin strip above
// it: the data comes ONLY from portal.ts with publishedOnly = true, none of
// the admin data is loaded, and "החשבון שלי" shows the apartment the admin
// picked (`apt`, validated against the building's list) through
// getAdminPreviewAccount — a staff-only entry point the portal never uses.
export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'finance', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'finance', 'edit');

  const sp = await searchParams;
  const tab: FinanceTab = one(sp.tab) === 'fund' ? 'fund' : 'operating';

  if (one(sp.view) === 'resident') {
    const apartments = await listApartmentNumbers();
    const requested = one(sp.apt) ?? null;
    const apt = requested && apartments.includes(requested) ? requested : null;
    const account = apt ? await getAdminPreviewAccount(apt) : null;
    return (
      <div>
        <AdminPreviewBar apartments={apartments} selected={apt} />
        <PortalScreen
          params={{ tab: one(sp.tab), m: one(sp.m), r: one(sp.r), n: one(sp.n), f: one(sp.f) }}
          user={{ name: account?.owner_display_name ?? null, apartments: apt ? [apt] : [] }}
          accounts={account ? [account] : []}
          support={{
            phone: env.NEXT_PUBLIC_PORTAL_SUPPORT_PHONE ?? null,
            email: env.NEXT_PUBLIC_PORTAL_SUPPORT_EMAIL ?? null,
          }}
          preview
        />
      </div>
    );
  }

  const period = parsePeriodParam(sp.m);

  const [categories, suppliers, drive, publishedRows] = await Promise.all([
    listCategories({ includeInactive: true }),
    listSuppliers({ status: 'active' }),
    getDriveConnectionPublic(),
    listPublishedMonths(),
  ]);
  const publishedMonths = publishedMonthKeys(publishedRows);

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
