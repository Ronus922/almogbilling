import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { resetDriveAttempts } from '@/lib/db/finance/documents';
import { retryPendingDriveUploads } from '@/lib/finance/drive-sync';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/finance/drive/retry — "נסה שוב": gives failed documents a fresh
// set of attempts and runs the backup now (synchronously, so the screen can
// show the outcome; bounded to 25 documents per press).
export async function POST() {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const reset = await resetDriveAttempts();
  const result = await retryPendingDriveUploads(25);
  await writeAudit({ actorUserId: actor.id, action: 'drive_retry', entityType: 'fin_drive_connection', metadata: { reset, ...result } });
  return NextResponse.json({ reset, ...result });
}
