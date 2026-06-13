import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listAssignableUsers } from '@/lib/db/users';

export const runtime = 'nodejs';

// GET /api/chat/users — active users for the "new conversation" picker,
// excluding the current user (you don't chat with yourself).
export async function GET() {
  let actorId: string;
  try {
    const actor = await requirePermission('internal_chat', 'view');
    actorId = actor.id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const users = await listAssignableUsers();
  return NextResponse.json({
    users: users
      .filter((u) => u.id !== actorId)
      .map((u) => ({ id: u.id, name: u.full_name ?? u.username })),
  });
}
