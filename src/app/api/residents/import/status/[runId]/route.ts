import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getResidentsImportRun } from '@/lib/residents/import-runner';

export const runtime = 'nodejs';

// GET /api/residents/import/status/[runId] — contacts:view. 404 if the run
// doesn't exist OR isn't a residents import (a contacts runId won't match
// kind='residents').
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { runId } = await ctx.params;
  const run = await getResidentsImportRun(runId);
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
