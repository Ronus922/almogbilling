import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDriveConnectionPublic } from '@/lib/db/finance/drive';
import { driveBackupStats } from '@/lib/db/finance/documents';
import { getGoogleConfig } from '@/lib/auth/google';
import { FINANCE_DRIVE_ACCOUNT } from '@/lib/constants/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/finance/drive/status — what the settings card shows: the connected
// account (if any), the backup counters, and whether OAuth is configured.
export async function GET() {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const [connection, stats] = await Promise.all([getDriveConnectionPublic(), driveBackupStats()]);
  return NextResponse.json({
    connection,
    stats,
    expectedAccount: FINANCE_DRIVE_ACCOUNT,
    oauthConfigured: getGoogleConfig() !== null,
  });
}
