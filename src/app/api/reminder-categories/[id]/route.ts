import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getReminderCategoryById,
  updateReminderCategory,
  softDeleteReminderCategory,
} from '@/lib/db/reminderCategories';
import { coerceReminderCategoryInput } from '@/lib/validation/reminderCategories';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/reminder-categories/[id]  (user_reminders:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('user_reminders', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const category = await getReminderCategoryById(id);
  if (!category) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ category });
}

// PATCH /api/reminder-categories/[id]  (user_reminders:edit)
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceReminderCategoryInput(bodyRec, 'update');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // is_archived passthrough (boolean) — allows restore/re-archive via PATCH.
  const patch: Record<string, unknown> = { ...result.fields };
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  try {
    const before = await getReminderCategoryById(id);
    if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const category = await updateReminderCategory(id, patch);
    if (!category) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await writeAudit({
      actorUserId: actor.id,
      action: 'updated',
      entityType: 'reminder_category',
      entityId: id,
      changes: { before, after: category },
    });

    return NextResponse.json({ category });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[PATCH /api/reminder-categories/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/reminder-categories/[id] — soft-delete (is_archived=true)  (user_reminders:edit)
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const before = await getReminderCategoryById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ok = await softDeleteReminderCategory(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'reminder_category',
    entityId: id,
    changes: { before },
  });

  return new NextResponse(null, { status: 204 });
}
