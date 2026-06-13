import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listContactsImportRuns } from '@/lib/contacts/import-runner';

export const runtime = 'nodejs';

// GET /api/contacts/import/runs — admin only. Last 10 contacts import runs, for
// an import-history UI.
export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const runs = await listContactsImportRuns(10);
  const items = runs.map((run) => ({
    runId: run.id,
    status: run.status,
    file_name: run.file_name,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created: run.created_rows,
    updated: run.updated_rows,
    skipped: run.skipped_rows,
    failed: run.failed_rows,
  }));

  return NextResponse.json({ items });
}
