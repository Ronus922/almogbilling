import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listRecurringSeries } from '@/lib/db/tasks';

export const runtime = 'nodejs';

// GET /api/tasks/recurring — active recurring series + next occurrence, for the
// "מחזוריות" tab to refresh after a save/delete without a full page reload.
export async function GET() {
  try {
    await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const series = await listRecurringSeries();
  return NextResponse.json({ series });
}
