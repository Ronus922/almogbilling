import { getSession } from '@/lib/auth/session';
import {
  getDashboardKpis,
  getLastImportedAt,
  getTabCounts,
  listDebtors,
  ALL_SORT_KEYS,
  type TabKey,
  type SortKey,
} from '@/lib/db/debtors';
import { KpiGrid } from './components/KpiGrid';
import { LastImportIndicator } from './components/LastImportIndicator';
import { DebtorsTabs } from './components/DebtorsTabs';
import { DebtorsToolbar } from './components/DebtorsToolbar';
import { DebtorsTable } from './components/DebtorsTable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TABS: TabKey[] = ['active', 'warning', 'legal-care', 'legal-proceeding', 'actions', 'archived'];

type SearchParams = Promise<{
  tab?: string;
  q?: string;
  apt?: string;
  sort?: string;
  page?: string;
}>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const tab = (VALID_TABS as string[]).includes(sp.tab ?? '') ? (sp.tab as TabKey) : 'active';
  const q = sp.q?.trim() || undefined;
  const apt = sp.apt?.trim() || undefined;
  const sort: SortKey = (ALL_SORT_KEYS as readonly string[]).includes(sp.sort ?? '')
    ? (sp.sort as SortKey)
    : 'total_debt_desc';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const session = await getSession();
  // Layout already redirects if no session — but TS still needs the narrow.
  const isAdmin = session?.user.is_admin ?? false;

  const [kpis, lastImportAt, tabCounts, listing] = await Promise.all([
    getDashboardKpis(),
    getLastImportedAt(),
    getTabCounts(),
    listDebtors({ tab, q, apt, sort, page }),
  ]);

  return (
    <div className="space-y-6">
      <KpiGrid kpis={kpis} />

      <LastImportIndicator
        lastImportAt={lastImportAt}
        isAdmin={isAdmin}
      />

      <DebtorsTabs active={tab} counts={tabCounts} />

      <div className="space-y-3 rounded-lg bg-card p-4 border">
        <DebtorsToolbar totalRows={listing.total} />
        <DebtorsTable
          rows={listing.rows}
          page={listing.page}
          totalPages={listing.totalPages}
          currentSort={sort}
          currentTab={tab}
          isAdmin={isAdmin}
        />
      </div>
    </div>
  );
}
