import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listActiveStatuses } from '@/lib/db/statuses';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const statuses = await listActiveStatuses();
  return NextResponse.json(statuses);
}
