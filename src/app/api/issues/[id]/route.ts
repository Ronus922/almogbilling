import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getIssueById,
  getIssueAssigneeStatus,
  updateIssue,
  deleteIssue,
  listIssueComments,
} from '@/lib/db/issues';
import { supplierExists } from '@/lib/db/suppliers';
import {
  listRemindersForEntity, createReminder, deleteRemindersForEntity,
} from '@/lib/db/reminders';
import { signedUrlForIssueImage, removeIssueImages } from '@/lib/storage/issueStorage';
import { coerceIssueInput, isUuid } from '@/lib/validation/issues';
// Generic reminders coercion lives in the tasks validation module (it is
// entity-agnostic — {remind_at, channel}); reused here for issue reminders.
import { coerceReminders } from '@/lib/validation/tasks';
import { notifyIssue } from '@/services/notifications';
import type { IssueImage } from '@/lib/types/issues';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/issues/[id] — issue + comments + signed image URLs  (issues:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('issues', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const issue = await getIssueById(id);
  if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const [comments, images, reminders] = await Promise.all([
    listIssueComments(id),
    Promise.all(
      issue.images.map(
        async (path): Promise<IssueImage> => ({ path, signed_url: await signedUrlForIssueImage(path) }),
      ),
    ),
    listRemindersForEntity('issue', id),
  ]);

  return NextResponse.json({ issue, comments, images, reminders });
}

// PATCH /api/issues/[id]  (issues:edit)
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceIssueInput(bodyRec, 'update');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // A linked supplier must exist and not be soft-deleted (only when (re)assigning one).
  if (result.fields.supplier_id && !(await supplierExists(result.fields.supplier_id))) {
    return NextResponse.json({ error: 'supplier_not_found' }, { status: 400 });
  }

  const reminders = coerceReminders(bodyRec);
  if (reminders && !reminders.ok) {
    return NextResponse.json({ error: reminders.error }, { status: 400 });
  }

  // is_archived passthrough (boolean).
  const patch: Record<string, unknown> = { ...result.fields };
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  try {
    const prev = await getIssueAssigneeStatus(id);
    if (!prev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Business rule: resolving requires resolution notes (either in this patch
    // or already persisted). Enforced here against the live row.
    if (result.fields.status === 'resolved') {
      const notesInPatch =
        typeof patch.resolution_notes === 'string' && patch.resolution_notes.trim() !== '';
      if (!notesInPatch) {
        const current = await getIssueById(id);
        const existingNotes = current?.resolution_notes?.trim();
        if (!existingNotes) {
          return NextResponse.json({ error: 'resolution_notes_required' }, { status: 400 });
        }
      }
    }

    const issue = await updateIssue(id, patch);
    if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Replace reminders if the client sent a reminders array (same as tasks).
    if (reminders && reminders.ok) {
      await deleteRemindersForEntity('issue', id);
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'issue',
          entityId: id,
          userId: issue.assigned_to_user_id ?? actor.id,
          remindAt: r.remind_at,
          channel: r.channel,
        });
      }
    }

    // Notify on assignment CHANGE to a new, different user (not the editor).
    const newAssignee = issue.assigned_to_user_id;
    if (newAssignee && newAssignee !== prev.assigned_to_user_id && newAssignee !== actor.id) {
      await notifyIssue({
        userId: newAssignee,
        type: 'issue_assigned',
        heading: 'תקלה הוקצתה לך',
        issue: { id: issue.id, title: issue.title, priority: issue.priority },
        notificationPriority: issue.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `issue_assigned:${issue.id}:${newAssignee}`,
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    // Notify the assignee on a status change they didn't make themselves.
    if (
      result.fields.status !== undefined &&
      result.fields.status !== prev.status &&
      issue.assigned_to_user_id &&
      issue.assigned_to_user_id !== actor.id
    ) {
      await notifyIssue({
        userId: issue.assigned_to_user_id,
        type: 'issue_status_changed',
        heading: `סטטוס התקלה עודכן`,
        issue: { id: issue.id, title: issue.title, priority: issue.priority },
        notificationPriority: 'normal',
        // One status-change notification per (issue, assignee, status) tuple.
        dedupeKey: `issue_status:${issue.id}:${issue.assigned_to_user_id}:${issue.status}`,
      });
    }

    return NextResponse.json({ issue });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    if (e.code === '23514') {
      return NextResponse.json({ error: 'invalid_value' }, { status: 400 });
    }
    console.error('[PATCH /api/issues/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/issues/[id]  (issues:edit) — physical delete + image cleanup.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const issue = await getIssueById(id);
  if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Best-effort image cleanup (storage), then delete the row.
  // issue_comments cascade via FK; tasks.issue_id is ON DELETE SET NULL.
  // Reminders use a generic entity_id (no FK), so clean them up explicitly.
  await removeIssueImages(issue.images);
  await deleteRemindersForEntity('issue', id);
  const ok = await deleteIssue(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
