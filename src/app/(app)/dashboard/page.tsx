import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import {
  getDashboardKpis,
  getLastImportedAt,
  getTabCounts,
  listDebtors,
  ALL_SORT_KEYS,
  type TabKey,
  type SortKey,
} from '@/lib/db/debtors';
import { getLastSuccessfulSyncAt } from '@/lib/db/syncRuns';
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

  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // Defense-in-depth: the debtors screen sits behind `dashboard` view. Every real
  // role has it (manager default + admin/super bypass + viewer); a principal
  // without it has no business server-rendering debtor data here.
  if (!hasPermission(actor.role, actor.permissions, 'dashboard', 'view')) {
    redirect('/login');
  }

  // Per-module capability flags drive every operational gate in the dashboard —
  // no blanket role check, so a manager with the permission gets the action.
  const canArchive = hasPermission(actor.role, actor.permissions, 'contacts', 'edit');
  const canSendWhatsapp = hasPermission(actor.role, actor.permissions, 'whatsapp', 'edit');
  const canSync = hasPermission(actor.role, actor.permissions, 'import', 'edit');
  const canChangeStatus = hasPermission(actor.role, actor.permissions, 'status_management', 'edit');
  // Bulk export / print (`export`) — manager+ only; a read-only viewer cannot
  // bulk-download the debtors list, only read the on-screen table.
  const canExport = hasPermission(actor.role, actor.permissions, 'export', 'view');

  const [kpis, lastImportAt, lastSyncAt, tabCounts, listing] = await Promise.all([
    getDashboardKpis(),
    getLastImportedAt(),
    getLastSuccessfulSyncAt(),
    getTabCounts(),
    listDebtors({ tab, q, apt, sort, page }),
  ]);

  return (
    <div className="space-y-6">
      <KpiGrid kpis={kpis} />

      <LastImportIndicator
        lastImportAt={lastImportAt}
        lastSyncAt={lastSyncAt}
        canSync={canSync}
      />

      <DebtorsTabs active={tab} counts={tabCounts} />

      <div className="space-y-3 rounded-2xl border border-line bg-white p-4 shadow-soft-sm">
        <DebtorsToolbar totalRows={listing.total} canExport={canExport} />
        <DebtorsTable
          rows={listing.rows}
          page={listing.page}
          totalPages={listing.totalPages}
          currentSort={sort}
          currentTab={tab}
          canChangeStatus={canChangeStatus}
          canArchive={canArchive}
          canSendWhatsapp={canSendWhatsapp}
        />
      </div>
    </div>
  );
}
