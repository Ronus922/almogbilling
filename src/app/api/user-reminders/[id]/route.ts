import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getUserReminderById,
  updateUserReminder,
  softDeleteUserReminder,
} from '@/lib/db/userReminders';
import { coerceUserReminderInput } from '@/lib/validation/userReminders';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/user-reminders/[id]  (user_reminders:view)
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

  const reminder = await getUserReminderById(id);
  if (!reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ reminder });
}

// PATCH /api/user-reminders/[id]  (user_reminders:edit)
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

  const result = coerceUserReminderInput(bodyRec, 'update');
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
    const before = await getUserReminderById(id);
    if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const reminder = await updateUserReminder(id, patch);
    if (!reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await writeAudit({
      actorUserId: actor.id,
      action: 'updated',
      entityType: 'reminder',
      entityId: id,
      changes: { before, after: reminder },
    });

    return NextResponse.json({ reminder });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[PATCH /api/user-reminders/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/user-reminders/[id] — soft-delete (is_archived=true)  (user_reminders:edit)
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

  const before = await getUserReminderById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ok = await softDeleteUserReminder(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'reminder',
    entityId: id,
    changes: { before },
  });

  return new NextResponse(null, { status: 204 });
}
