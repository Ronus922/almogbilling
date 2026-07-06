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
import { listEntityAssigneeKeys } from '@/lib/db/entityAssignees';
import {
  listRemindersForEntity, createReminder, deleteRemindersForEntity,
} from '@/lib/db/reminders';
import { deleteNotificationsForEntity } from '@/lib/db/notifications';
import { signedUrlForIssueImage, removeIssueImages } from '@/lib/storage/issueStorage';
import { coerceIssueInput, isUuid } from '@/lib/validation/issues';
import { coerceAssignees } from '@/lib/validation/assignee';
// Generic reminders coercion lives in the tasks validation module (it is
// entity-agnostic — {remind_at, channel}); reused here for issue reminders.
import { coerceReminders } from '@/lib/validation/tasks';
import { notifyIssue } from '@/services/notifications';
import {
  dispatchCreateNotifications,
  buildMatrixRecipients,
  filterAddedAssignees,
} from '@/services/createNotify';
import { coerceNotifySelection } from '@/lib/notify/selection';
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

  // Assignees (optional on PATCH). If sent, each supplier must exist + not be deleted.
  const assigneesV = coerceAssignees(bodyRec);
  if (assigneesV && !assigneesV.ok) {
    return NextResponse.json({ error: assigneesV.error }, { status: 400 });
  }
  const assignees = assigneesV && assigneesV.ok ? assigneesV.assignees : undefined;
  if (assignees) {
    for (const a of assignees) {
      if (a.assignee_type === 'supplier' && !(await supplierExists(a.id))) {
        return NextResponse.json({ error: 'supplier_not_found' }, { status: 400 });
      }
    }
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
    // Full previous key set (users + suppliers) → drives the "added set" the
    // edit-form notification matrix governs.
    const prevKeys = new Set(await listEntityAssigneeKeys('issue', id));

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

    const issue = await updateIssue(id, patch, assignees, actor.id);
    if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const userIds = issue.assignees.map((a) => a.user_id).filter((v): v is string => v !== null);

    // Replace reminders if the client sent a reminders array → ONE row per
    // reminder, owned by the editor. The engine fans out to the issue's CURRENT
    // user-assignees at fire time (falling back to this owner when there are
    // none), so a single reminder is never duplicated per assignee.
    if (reminders && reminders.ok) {
      await deleteRemindersForEntity('issue', id);
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'issue',
          entityId: id,
          userId: actor.id,
          remindAt: r.remind_at,
          channels: r.channels,
        });
      }
    }

    // Zombie guard (defense in depth): a terminal transition — resolved / closed /
    // archived — purges any pending reminders so none fire post-resolution.
    // Idempotent; complements the engine-side skip and the DELETE route.
    if (issue.is_archived || issue.status === 'resolved' || issue.status === 'closed') {
      await deleteRemindersForEntity('issue', id);
    }

    // In-app assignment bell → each NEWLY-ADDED user assignee (set diff), except
    // the editor. channel:'in_app' suppresses the auto-email — external delivery
    // (email / WhatsApp) is now matrix-driven (opt-in), same as the create form.
    const prevSet = new Set(prev.assignedUserIds);
    for (const uid of userIds) {
      if (prevSet.has(uid) || uid === actor.id) continue;
      await notifyIssue({
        userId: uid,
        type: 'issue_assigned',
        heading: 'תקלה הוקצתה לך',
        issue: { id: issue.id, title: issue.title, priority: issue.priority },
        notificationPriority: issue.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `issue_assigned:${issue.id}:${uid}`,
        channel: 'in_app',
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    // External notifications (email / WhatsApp) — the editor's matrix picks only,
    // one row per recipient: "me" + each NEWLY-ADDED assignee (user OR supplier).
    // Pre-existing assignees are excluded (the status-change notification below
    // covers them on its own terms). Best-effort, never blocks the edit.
    const recipients = buildMatrixRecipients({
      selection: coerceNotifySelection(bodyRec.notify),
      meUserId: actor.id,
      assignees: filterAddedAssignees(prevKeys, issue.assignees),
      meMessage: `עדכנת תקלה: ${issue.title}`,
      assigneeMessage: () => `הוקצתה לך תקלה: ${issue.title}`,
    });
    if (recipients.length > 0) {
      void dispatchCreateNotifications({
        title: `תקלה: ${issue.title}`,
        actionUrl: `/issues?issue=${issue.id}`,
        recipients,
      });
    }

    // Notify every PRE-EXISTING user assignee (≠ editor) on a status change.
    // A user added in this same PATCH already got the 'assigned' notification
    // above, so skip them here to avoid a double notification.
    if (result.fields.status !== undefined && result.fields.status !== prev.status) {
      for (const uid of userIds) {
        if (uid === actor.id || !prevSet.has(uid)) continue;
        await notifyIssue({
          userId: uid,
          type: 'issue_status_changed',
          heading: `סטטוס התקלה עודכן`,
          issue: { id: issue.id, title: issue.title, priority: issue.priority },
          notificationPriority: 'normal',
          // One status-change notification per (issue, assignee, status) tuple.
          dedupeKey: `issue_status:${issue.id}:${uid}:${issue.status}`,
        });
      }
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
  // Reminders + notifications use a generic entity_id (no FK), so clean them
  // up explicitly — otherwise the bell keeps showing ghosts of a deleted issue.
  await removeIssueImages(issue.images);
  await deleteRemindersForEntity('issue', id);
  await deleteNotificationsForEntity('issue', id);
  const ok = await deleteIssue(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
