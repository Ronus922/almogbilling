import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getTaskById,
  getTaskUserAssignees,
  updateTask,
  deleteTask,
} from '@/lib/db/tasks';
import { listEntityAssigneeKeys } from '@/lib/db/entityAssignees';
import {
  listRemindersForEntity,
  createReminder,
  deleteRemindersForEntity,
} from '@/lib/db/reminders';
import { deleteNotificationsForEntity } from '@/lib/db/notifications';
import { listTaskComments } from '@/lib/db/tasks';
import { supplierExists } from '@/lib/db/suppliers';
import { coerceTaskInput, coerceReminders, coerceRecurrence, reminderInPast } from '@/lib/validation/tasks';
import { coerceAssignees } from '@/lib/validation/assignee';
import {
  applyRecurrenceOnSave,
  completeRecurringOccurrence,
  getRecurrenceById,
  skipTaskOccurrence,
} from '@/lib/recurrence/series';
import { notifyTask } from '@/services/notifications';
import {
  dispatchCreateNotifications,
  buildMatrixRecipients,
  filterAddedAssignees,
} from '@/services/createNotify';
import { coerceNotifySelection } from '@/lib/notify/selection';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id] — task + comments + reminders  (tasks:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const task = await getTaskById(id);
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const [comments, reminders] = await Promise.all([
    listTaskComments(id),
    listRemindersForEntity('task', id),
  ]);
  // The recurrence rule (if this task is part of a series) so the edit drawer can
  // render the rule + the per-occurrence series actions.
  const recurrence = task.recurrence_id ? await getRecurrenceById(task.recurrence_id) : null;
  return NextResponse.json({ task, comments, reminders, recurrence });
}

// PATCH /api/tasks/[id]  (tasks:edit)
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('tasks', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceTaskInput(bodyRec, 'update');
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

  // is_archived passthrough (boolean).
  const patch: Record<string, unknown> = { ...result.fields };
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  const reminders = coerceReminders(bodyRec);
  if (reminders && !reminders.ok) {
    return NextResponse.json({ error: reminders.error }, { status: 400 });
  }
  // Edit: block NEW past reminders, but exempt already-persisted ones (re-sent
  // verbatim) so editing a task with an old past reminder isn't blocked.
  if (reminders && reminders.ok) {
    const existingMs = new Set(
      (await listRemindersForEntity('task', id)).map((r) => Date.parse(r.remind_at)),
    );
    if (reminderInPast(reminders.reminders, existingMs)) {
      return NextResponse.json({ error: 'reminder_in_past' }, { status: 400 });
    }
  }

  const recurrence = coerceRecurrence(bodyRec);
  if (recurrence && !recurrence.ok) {
    return NextResponse.json({ error: recurrence.error }, { status: 400 });
  }

  // The pre-save row: the source of truth for "is this an active series" (a
  // resolved `recurrence` view only exists for active series rows) and for
  // deciding whether the due date genuinely moved.
  const before = await getTaskById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // A recurrence rule needs an anchor (the task's due date = series start). If a
  // rule is being set/kept, the EFFECTIVE due date after this save must exist —
  // either from this PATCH's due_date or, if the key wasn't sent, the stored one.
  if (recurrence && recurrence.ok && recurrence.rule) {
    const f = result.fields as { due_date?: string | null };
    const effectiveDue = Object.prototype.hasOwnProperty.call(f, 'due_date')
      ? f.due_date ?? null
      : before.due_date ?? null;
    if (!effectiveDue) {
      return NextResponse.json({ error: 'recurrence_requires_due_date' }, { status: 400 });
    }
  }

  // Completing a recurring task does NOT close it — the single series row
  // advances to its next occurrence (migration 067). The status is therefore
  // stripped from the patch and applied by the series engine instead, so the row
  // never flickers through 'done' (which would purge its reminders below) and the
  // completion lands in task_occurrence_completions.
  const requestedStatus = (patch as { status?: string }).status;
  const advanceSeries =
    (requestedStatus === 'done' || requestedStatus === 'cancelled') && before.recurrence !== null;
  if (advanceSeries) delete (patch as { status?: string }).status;

  try {
    const prevUsers = await getTaskUserAssignees(id);
    if (prevUsers === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // Full previous key set (users + suppliers) → drives the "added set" the
    // edit-form notification matrix governs.
    const prevKeys = new Set(await listEntityAssigneeKeys('task', id));

    let task = await updateTask(id, patch, assignees, actor.id);
    if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Recurrence side-channel (only when the client sent the key): a rule upserts
    // and marks the row as a series; null ends + detaches it. Runs BEFORE the
    // advance below so the advance uses the rule as just saved, and so the anchor
    // is taken from the CURRENT occurrence rather than the advanced one. The
    // anchor moves only when the due date really changed — the edit form re-sends
    // due_date on every save, so key presence alone is not enough.
    if (recurrence && recurrence.ok) {
      await applyRecurrenceOnSave(
        id, recurrence.rule, task.due_date, task.due_date !== before.due_date,
      );
    }

    // 'done' → log the occurrence and move on. 'cancelled' → skip it (no
    // completion logged) and exclude the date so it can't come back.
    if (advanceSeries) {
      const advanced = requestedStatus === 'done'
        ? await completeRecurringOccurrence(id, {
          id: actor.id,
          name: actor.full_name ?? actor.username,
        })
        : await skipTaskOccurrence(id);
      // Null only if the series went dormant mid-request (e.g. the same save also
      // switched recurrence off) — fall back to the plain status change so the
      // request is never a silent no-op.
      const after = advanced
        ? await getTaskById(id)
        : await updateTask(id, { status: requestedStatus as typeof task.status }, undefined, actor.id);
      if (after) task = after;
    }

    const userIds = task.assignees.map((a) => a.user_id).filter((v): v is string => v !== null);

    // Replace reminders if the client sent a reminders array → ONE row per
    // reminder, owned by the editor. The engine fans out to the task's CURRENT
    // user-assignees at fire time (falling back to this owner when there are
    // none), so a single reminder is never duplicated per assignee.
    if (reminders && reminders.ok) {
      await deleteRemindersForEntity('task', id);
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'task',
          entityId: id,
          userId: actor.id,
          remindAt: r.remind_at,
          channels: r.channels,
          notifyOwner: r.notify_owner,
        });
      }
    }

    // Zombie guard (defense in depth): a terminal transition — done / cancelled /
    // archived — purges any pending reminders so none fire post-completion.
    // Idempotent; complements the engine-side skip and the DELETE route.
    if (task.is_archived || task.status === 'done' || task.status === 'cancelled') {
      await deleteRemindersForEntity('task', id);
    }

    // "שלח גם אליי" → immediate in-app bell to the editor (skip when the task just
    // went terminal, which purges the reminders above). self ⟺ notify_owner.
    if (
      reminders && reminders.ok && reminders.reminders.some((rem) => rem.notify_owner) &&
      !(task.is_archived || task.status === 'done' || task.status === 'cancelled')
    ) {
      void notifyTask({
        userId: actor.id,
        type: 'reminder',
        heading: 'נקבעה תזכורת שתגיע גם אליך',
        task: { id: task.id, title: task.title, priority: task.priority, due_date: task.due_date },
        channel: 'in_app',
        dedupeKey: `reminder_self:${task.id}:${actor.id}`,
      });
    }

    // In-app assignment bell → each NEWLY-ADDED user assignee (set diff), except
    // the editor. channel:'in_app' suppresses the auto-email — external delivery
    // (email / WhatsApp) is now matrix-driven (opt-in), same as the create form.
    const prevSet = new Set(prevUsers);
    for (const uid of userIds) {
      if (prevSet.has(uid) || uid === actor.id) continue;
      await notifyTask({
        userId: uid,
        type: 'task_assigned',
        heading: 'משימה הוקצתה לך',
        task: { id: task.id, title: task.title, priority: task.priority, due_date: task.due_date },
        notificationPriority: task.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `task_assigned:${task.id}:${uid}`,
        channel: 'in_app',
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    // External notifications (email / WhatsApp) — the editor's matrix picks only,
    // one row per recipient: "me" + each NEWLY-ADDED assignee (user OR supplier).
    // Pre-existing assignees are excluded (already notified). Best-effort.
    const recipients = buildMatrixRecipients({
      selection: coerceNotifySelection(bodyRec.notify),
      meUserId: actor.id,
      assignees: filterAddedAssignees(prevKeys, task.assignees),
      meMessage: `עדכנת משימה: ${task.title}`,
      assigneeMessage: () => `הוקצתה לך משימה: ${task.title}`,
    });
    if (recipients.length > 0) {
      void dispatchCreateNotifications({
        title: `משימה: ${task.title}`,
        actionUrl: `/tasks?task=${task.id}`,
        details: {
          description: task.description,
          targetLabel: task.target_label,
          dueDate: task.due_date,
          dueTime: task.due_time,
          // Edit-time assignment → the assigner is the editing actor, not the
          // original creator.
          assignedByName: actor.full_name ?? actor.username,
        },
        recipients,
      });
    }

    return NextResponse.json({ task });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    logger.error('[PATCH /api/tasks/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]  (tasks:edit)
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('tasks', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  // task_comments cascade via FK; reminders + notifications use a generic
  // entity_id (no FK), so clean them up explicitly to avoid orphaned rows that
  // keep haunting the bell (deleteTask soft-archives, so this also covers the
  // archived-task variant).
  await deleteRemindersForEntity('task', id);
  await deleteNotificationsForEntity('task', id);
  const ok = await deleteTask(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
