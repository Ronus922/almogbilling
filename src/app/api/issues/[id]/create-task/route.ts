import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getIssueById, createTaskFromIssue } from '@/lib/db/issues';
import { isUuid } from '@/lib/validation/issues';
import { notifyTask } from '@/services/notifications';
import type { TaskPriority } from '@/lib/types/tasks';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/issues/[id]/create-task  (issues:edit)
 *
 * Creates a task linked to the issue (issue_id FK), copying title, description,
 * priority and assignee — in a single transaction. One task per issue (returns
 * 409 if a task is already linked). Mirrors the assignment-notification of the
 * tasks module so the assignee is told about the new task.
 */
export async function POST(_req: NextRequest, ctx: RouteCtx) {
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

  const issue = await getIssueById(id);
  if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const task = await createTaskFromIssue(issue, actor.id, actor.full_name ?? actor.username);
    if (!task) {
      return NextResponse.json({ error: 'task_already_linked' }, { status: 409 });
    }

    // Notify each copied user assignee about the new task (except the creator).
    for (const uid of task.assigned_user_ids) {
      if (uid === actor.id) continue;
      await notifyTask({
        userId: uid,
        type: 'task_assigned',
        heading: 'משימה חדשה הוקצתה לך (מתקלה)',
        task: {
          id: task.id,
          title: task.title,
          priority: task.priority as TaskPriority,
          due_date: task.due_date,
        },
        notificationPriority: task.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `task_assigned:${task.id}:${uid}`,
        extraDetails: [{ label: 'נוצר מתקלה', value: issue.title }],
      });
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/issues/:id/create-task]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
