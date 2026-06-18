import { NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listRoomTargets, listAreaTargets } from '@/lib/db/targets';

export const runtime = 'nodejs';

// GET /api/targets — options for the optional task/issue target picker.
// Available to anyone who can view tasks OR issues (the field lives in those
// forms). Does NOT touch the RBAC matrix — just an appropriate guard for a
// shared read-only options endpoint, so it never couples the picker to the
// contacts / rooms_areas module permissions.
export async function GET() {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const allowed =
    hasPermission(actor.role, actor.permissions, 'tasks', 'view') ||
    hasPermission(actor.role, actor.permissions, 'issues', 'view');
  if (!allowed) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [rooms, areas] = await Promise.all([listRoomTargets(), listAreaTargets()]);
  return NextResponse.json({ rooms, areas });
}
