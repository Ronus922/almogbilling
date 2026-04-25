import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listCompletedActionsByDebtor } from '@/lib/db/completedActions';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const rows = await listCompletedActionsByDebtor(id);
  return NextResponse.json(rows);
}
