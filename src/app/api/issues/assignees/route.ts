import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listAssignableUsers } from '@/lib/db/users';

export const runtime = 'nodejs';

// GET /api/issues/assignees — active users for the assignee picker (issues:view).
export async function GET() {
  try {
    await requirePermission('issues', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const users = await listAssignableUsers();
  return NextResponse.json({
    users: users.map((u) => ({ id: u.id, name: u.full_name ?? u.username })),
  });
}
