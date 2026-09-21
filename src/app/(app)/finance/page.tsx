import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listEntriesForMonth } from '@/lib/db/finance/entries';
import { listCategories } from '@/lib/db/finance/categories';
import { getDriveConnectionPublic } from '@/lib/db/finance/drive';
import { listSuppliers } from '@/lib/db/suppliers';
import { parseMonthParam, periodMonthOf } from '@/lib/finance/period';
import { FinancePageClient } from '@/components/finance/FinancePageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ m?: string | string[] }>;

// /finance — monthly overview of the finance transparency module.
// Gate: module `finance` (admin / super_admin in slice A). The supplier
// roster is loaded here (like tasks/issues do) and searched client-side.
export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'finance', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'finance', 'edit');

  const sp = await searchParams;
  const month = parseMonthParam(sp.m);

  const [entries, categories, suppliers, drive] = await Promise.all([
    listEntriesForMonth(periodMonthOf(month)),
    listCategories({ includeInactive: true }),
    listSuppliers({ status: 'active' }),
    getDriveConnectionPublic(),
  ]);

  return (
    <FinancePageClient
      key={month}
      month={month}
      entries={entries}
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
