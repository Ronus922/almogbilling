import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getImportRun } from '@/lib/db/importRuns';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  try {
    await requirePermission('import', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { runId } = await ctx.params;
  const run = await getImportRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(run);
}
