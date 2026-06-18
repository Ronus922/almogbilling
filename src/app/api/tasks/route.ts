import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listTasks, createTask, getTaskById, getTaskKpis } from '@/lib/db/tasks';
import { supplierExists } from '@/lib/db/suppliers';
import { createReminder } from '@/lib/db/reminders';
import { coerceTaskInput, coerceReminders } from '@/lib/validation/tasks';
import { notifyTask } from '@/services/notifications';
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

  // A linked supplier must exist and not be soft-deleted (when assigning one).
  if (result.fields.supplier_id && !(await supplierExists(result.fields.supplier_id))) {
    return NextResponse.json({ error: 'supplier_not_found' }, { status: 400 });
  }

  const reminders = coerceReminders(bodyRec);
  if (reminders && !reminders.ok) {
    return NextResponse.json({ error: reminders.error }, { status: 400 });
  }

  try {
    const task = await createTask(
      result.fields as Partial<TaskWritableFields> & { title: string },
      actor.id,
      actor.full_name ?? actor.username,
    );

    // Reminders attached to this task.
    if (reminders && reminders.ok) {
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'task',
          entityId: task.id,
          userId: task.assigned_to_user_id ?? actor.id,
          remindAt: r.remind_at,
          channel: r.channel,
        });
      }
    }

    // Assignment notification (only when assigned to someone other than the creator).
    if (task.assigned_to_user_id && task.assigned_to_user_id !== actor.id) {
      await notifyTask({
        userId: task.assigned_to_user_id,
        type: 'task_assigned',
        heading: 'משימה חדשה הוקצתה לך',
        task: { id: task.id, title: task.title, priority: task.priority, due_date: task.due_date },
        notificationPriority: task.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `task_assigned:${task.id}:${task.assigned_to_user_id}`,
        extraDetails: [{ label: 'הוקצה על ידי', value: actor.full_name ?? actor.username }],
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
