import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listTasks, createTask, getTaskById, getTaskKpis } from '@/lib/db/tasks';
import { supplierExists } from '@/lib/db/suppliers';
import { createReminder } from '@/lib/db/reminders';
import { coerceTaskInput, coerceReminders } from '@/lib/validation/tasks';
import { coerceAssignees } from '@/lib/validation/assignee';
import { notifyTask } from '@/services/notifications';
import { dispatchCreateNotifications, buildMatrixRecipients } from '@/services/createNotify';
import { coerceNotifySelection } from '@/lib/notify/selection';
import type {
  RelatedEntityType,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskWritableFields,
} from '@/lib/types/tasks';

export const runtime = 'nodejs';

const STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const SORTS: readonly TaskSort[] = ['created_desc', 'due_asc', 'priority_desc', 'updated_desc'];
const RELATED_ENTITY_TYPES: readonly RelatedEntityType[] = [
  'debtor',
  'building',
  'supplier',
  'contact',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/tasks?status&priority&assignedTo&relatedEntityType&relatedEntityId&search&sort&kpis  (tasks:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const statusRaw = sp.get('status')?.trim();
  const status =
    statusRaw && statusRaw !== 'all' && STATUSES.includes(statusRaw as TaskStatus)
      ? (statusRaw as TaskStatus)
      : undefined;

  const priorityRaw = sp.get('priority')?.trim();
  const priority =
    priorityRaw && priorityRaw !== 'all' && PRIORITIES.includes(priorityRaw as TaskPriority)
      ? (priorityRaw as TaskPriority)
      : undefined;

  const assignedToRaw = sp.get('assignedTo')?.trim();
  const assignedTo = assignedToRaw && assignedToRaw !== 'all' ? assignedToRaw : undefined;

  const supplierIdRaw = sp.get('supplier_id')?.trim();
  const supplier_id =
    supplierIdRaw && supplierIdRaw !== 'all' && UUID_RE.test(supplierIdRaw) ? supplierIdRaw : undefined;

  const retRaw = sp.get('relatedEntityType')?.trim();
  const relatedEntityType =
    retRaw && retRaw !== 'all' && RELATED_ENTITY_TYPES.includes(retRaw as RelatedEntityType)
      ? (retRaw as RelatedEntityType)
      : undefined;

  const reidRaw = sp.get('relatedEntityId')?.trim();
  const relatedEntityId = reidRaw && UUID_RE.test(reidRaw) ? reidRaw : undefined;

  const search = sp.get('search')?.trim() || undefined;

  const sortRaw = sp.get('sort')?.trim();
  const sort = sortRaw && SORTS.includes(sortRaw as TaskSort) ? (sortRaw as TaskSort) : undefined;

  const items = await listTasks({
    status,
    priority,
    assignedTo,
    supplier_id,
    relatedEntityType,
    relatedEntityId,
    search,
    sort,
  });

  if (sp.get('kpis') === '1') {
    const kpis = await getTaskKpis();
    return NextResponse.json({ items, kpis });
  }
  return NextResponse.json({ items });
}

// POST /api/tasks  (tasks:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('tasks', 'edit');
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
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceTaskInput(bodyRec, 'create');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Assignees (mixed users + suppliers). Each supplier must exist + not be deleted.
  const assigneesV = coerceAssignees(bodyRec);
  if (assigneesV && !assigneesV.ok) {
    return NextResponse.json({ error: assigneesV.error }, { status: 400 });
  }
  const assignees = assigneesV && assigneesV.ok ? assigneesV.assignees : [];
  for (const a of assignees) {
    if (a.assignee_type === 'supplier' && !(await supplierExists(a.id))) {
      return NextResponse.json({ error: 'supplier_not_found' }, { status: 400 });
    }
  }

  const reminders = coerceReminders(bodyRec);
  if (reminders && !reminders.ok) {
    return NextResponse.json({ error: reminders.error }, { status: 400 });
  }

  try {
    const task = await createTask(
      result.fields as Partial<TaskWritableFields> & { title: string },
      assignees,
      actor.id,
      actor.full_name ?? actor.username,
    );

    const userIds = task.assignees
      .map((a) => a.user_id)
      .filter((v): v is string => v !== null);

    // Reminders → ONE row per reminder, owned by the creator. The engine fans out
    // to the task's CURRENT user-assignees at fire time (falling back to this
    // owner when there are none), so a single reminder is never duplicated per
    // assignee.
    if (reminders && reminders.ok) {
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'task',
          entityId: task.id,
          userId: actor.id,
          remindAt: r.remind_at,
          channels: r.channels,
        });
      }
    }

    // In-app assignment bell → each user assignee other than the creator
    // (channel:'in_app' suppresses the auto-email; external is matrix-driven).
    for (const uid of userIds) {
      if (uid === actor.id) continue;
      await notifyTask({
        userId: uid,
        type: 'task_assigned',
        heading: 'משימה חדשה הוקצתה לך',
        task: { id: task.id, title: task.title, priority: task.priority, due_date: task.due_date },
        notificationPriority: task.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `task_assigned:${task.id}:${uid}`,
        channel: 'in_app',
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    // External notifications (email / WhatsApp) — ONLY the creator's matrix picks,
    // one row per recipient (me + each selected assignee). Best-effort.
    const recipients = buildMatrixRecipients({
      selection: coerceNotifySelection(bodyRec.notify),
      meUserId: actor.id,
      assignees: task.assignees,
      meMessage: `יצרת משימה חדשה: ${task.title}`,
      assigneeMessage: () => `הוקצתה לך משימה חדשה: ${task.title}`,
    });
    if (recipients.length > 0) {
      void dispatchCreateNotifications({
        title: `משימה: ${task.title}`,
        actionUrl: `/tasks?task=${task.id}`,
        recipients,
      });
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/tasks]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
