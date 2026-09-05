import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { reorderTasks, type ReorderItem } from '@/lib/db/tasks';
import type { TaskPriority } from '@/lib/types/tasks';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const PRIORITIES: readonly TaskPriority[] = ['normal', 'high', 'urgent'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/tasks/reorder — batch kanban re-prioritise + reorder (tasks:edit).
// The board groups by priority; this writes the dragged lane's priority + order.
// Body: { items: [{ id, priority, sort_order }] }
export async function PATCH(req: NextRequest) {
  try {
    await requirePermission('tasks', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json({ error: 'invalid_items' }, { status: 400 });
  }
  if (rawItems.length > 500) {
    return NextResponse.json({ error: 'too_many_items' }, { status: 400 });
  }

  const items: ReorderItem[] = [];
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') {
      return NextResponse.json({ error: 'invalid_item' }, { status: 400 });
    }
    const rec = it as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : '';
    const priority = typeof rec.priority === 'string' ? rec.priority : '';
    const sortOrder = typeof rec.sort_order === 'number' ? rec.sort_order : NaN;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    if (!PRIORITIES.includes(priority as TaskPriority)) {
      return NextResponse.json({ error: 'invalid_priority' }, { status: 400 });
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return NextResponse.json({ error: 'invalid_sort_order' }, { status: 400 });
    }
    items.push({ id, priority, sort_order: sortOrder });
  }

  try {
    await reorderTasks(items);
    return NextResponse.json({ ok: true, updated: items.length });
  } catch (err) {
    logger.error('[PATCH /api/tasks/reorder]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
