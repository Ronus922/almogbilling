import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getContactsImportRun } from '@/lib/contacts/import-runner';

export const runtime = 'nodejs';

// GET /api/contacts/import/status/[runId] — admin only. 404 if the run doesn't
// exist OR isn't a contacts import (a debtors runId won't match kind='contacts').
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { runId } = await ctx.params;
  const run = await getContactsImportRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({
    runId: run.id,
    status: run.status,
    total_rows: run.total_rows,
    processed_rows: run.processed_rows,
    created: run.created_rows,
    updated: run.updated_rows,
    skipped: run.skipped_rows,
    failed: run.failed_rows,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error_summary: run.error_message,
    error_details: run.error_details?.slice(0, 50) ?? null,
  });
}
