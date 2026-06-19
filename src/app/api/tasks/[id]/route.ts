import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getTaskById,
  getTaskUserAssignees,
  updateTask,
  deleteTask,
} from '@/lib/db/tasks';
import {
  listRemindersForEntity,
  createReminder,
  deleteRemindersForEntity,
} from '@/lib/db/reminders';
import { listTaskComments } from '@/lib/db/tasks';
import { supplierExists } from '@/lib/db/suppliers';
import { coerceTaskInput, coerceReminders } from '@/lib/validation/tasks';
import { coerceAssignees } from '@/lib/validation/assignee';
import { notifyTask } from '@/services/notifications';

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
  return NextResponse.json({ task, comments, reminders });
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

  try {
    const prevUsers = await getTaskUserAssignees(id);
    if (prevUsers === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const task = await updateTask(id, patch, assignees, actor.id);
    if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const userIds = task.assignees.map((a) => a.user_id).filter((v): v is string => v !== null);

    // Replace reminders if the client sent a reminders array → one per user
    // assignee (or the editor when there are none).
    if (reminders && reminders.ok) {
      await deleteRemindersForEntity('task', id);
      const reminderUsers = userIds.length > 0 ? userIds : [actor.id];
      for (const r of reminders.reminders) {
        for (const uid of reminderUsers) {
          await createReminder({
            entityType: 'task',
            entityId: id,
            userId: uid,
            remindAt: r.remind_at,
            channel: r.channel,
          });
        }
      }
    }

    // Notify each NEWLY-ADDED user assignee (set diff), excluding the editor.
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
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    return NextResponse.json({ task });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[PATCH /api/tasks/[id]]', err);
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
  // task_comments cascade via FK; reminders use a generic entity_id (no FK), so
  // clean them up explicitly to avoid orphaned rows.
  await deleteRemindersForEntity('task', id);
  const ok = await deleteTask(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
