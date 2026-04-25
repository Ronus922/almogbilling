import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getImportRun } from '@/lib/db/importRuns';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const run = await getImportRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(run);
}
