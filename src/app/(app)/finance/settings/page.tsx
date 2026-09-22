import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { isElevatedRole } from '@/lib/permissions/constants';
import { listCategories } from '@/lib/db/finance/categories';
import { getDriveConnectionPublic } from '@/lib/db/finance/drive';
import { driveBackupStats } from '@/lib/db/finance/documents';
import { getFinanceSettings } from '@/lib/db/finance/settings';
import { getGoogleConfig } from '@/lib/auth/google';
import { FINANCE_DRIVE_ACCOUNT } from '@/lib/constants/finance';
import { FinanceSettingsClient } from '@/components/finance/FinanceSettingsClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ drive?: string | string[]; reason?: string | string[] }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

// /finance/settings — categories, the Google Drive connection and the
// "show documents to residents" switch.
export default async function FinanceSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'finance', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'finance', 'edit');
  // Same rule as requireDriveConnector(): finance:edit AND an admin-tier role.
  const canConnectDrive = canEdit && isElevatedRole(actor.role);

  const sp = await searchParams;
  const [categories, connection, stats, settings] = await Promise.all([
    listCategories({ includeInactive: true }),
    getDriveConnectionPublic(),
    driveBackupStats(),
    getFinanceSettings(),
  ]);

  return (
    <FinanceSettingsClient
      categories={categories}
      drive={{ connection, stats, expectedAccount: FINANCE_DRIVE_ACCOUNT, oauthConfigured: getGoogleConfig() !== null }}
      settings={settings}
      canEdit={canEdit}
      canConnectDrive={canConnectDrive}
      driveNotice={{ status: one(sp.drive), reason: one(sp.reason) }}
    />
  );
}
