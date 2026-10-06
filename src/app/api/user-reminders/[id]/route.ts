import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getUserReminderById,
  updateUserReminder,
  softDeleteUserReminder,
} from '@/lib/db/userReminders';
import { coerceAttachmentIds, coerceUserReminderInput } from '@/lib/validation/userReminders';
import { linkAttachments, listReminderAttachments, toAttachmentView } from '@/lib/db/userReminderAttachments';
import { REMINDER_ATTACHMENT_LIMITS } from '@/lib/constants/reminderAttachments';
import { reminderPatchAllowed, reminderRole } from '@/lib/userReminders/access';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/user-reminders/[id]  (user_reminders:view) — the reminder plus its
// files (`attachments`, each with its /api/files proxy url). Only for its
// creator or its assignee: anyone else gets the SAME 404 as a missing id —
// never a body, no existence oracle (the issues module's read rule).
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const reminder = await getUserReminderById(id);
  if (!reminder || reminderRole(actor.id, reminder) === 'none') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const attachments = (await listReminderAttachments(id)).map(toAttachmentView);
  return NextResponse.json({ reminder: { ...reminder, attachments } });
}

// PATCH /api/user-reminders/[id]  (user_reminders:edit)
// Partial: only the keys sent change. New staged files (attachment_ids) are
// linked on top of the existing ones; removal goes through
// DELETE /api/user-reminders/attachments/[attachmentId].
// The creator changes anything; the assignee only `status` (the card's "סמן
// כהושלם", the panel's status select) — any other key in their body is 403;
// anyone else is 403 (lib/userReminders/access.ts, 06/10/2026). The actor is
// checked before the body is validated, so a stranger learns nothing.
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

  const before = await getUserReminderById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const role = reminderRole(actor.id, before);
  if (role === 'none') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;
  if (!reminderPatchAllowed(role, Object.keys(bodyRec))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const result = coerceUserReminderInput(bodyRec, 'update');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const attachments = coerceAttachmentIds(bodyRec);
  if (!attachments.ok) return NextResponse.json({ error: attachments.error }, { status: 400 });

  // is_archived passthrough (boolean) — allows restore/re-archive via PATCH.
  const patch: Record<string, unknown> = { ...result.fields };
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  try {
    if (attachments.ids.length > 0) {
      const existing = await listReminderAttachments(id);
      if (existing.length + attachments.ids.length > REMINDER_ATTACHMENT_LIMITS.maxFiles) {
        return NextResponse.json({ error: 'too_many_attachments' }, { status: 400 });
      }
    }

    const reminder = await updateUserReminder(id, patch);
    if (!reminder) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const linked = await linkAttachments(id, attachments.ids, actor.id);

    await writeAudit({
      actorUserId: actor.id,
      action: 'updated',
      entityType: 'reminder',
      entityId: id,
      changes: { before, after: reminder },
      metadata: linked > 0 ? { attachments_linked: linked } : undefined,
    });

    return NextResponse.json({
      reminder, attachments_linked: linked, attachments_requested: attachments.ids.length,
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    logger.error('[PATCH /api/user-reminders/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/user-reminders/[id] — soft-delete (is_archived=true)  (user_reminders:edit)
// The creator alone; the assignee and anyone else get 403.
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
  if (reminderRole(actor.id, before) !== 'creator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

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
