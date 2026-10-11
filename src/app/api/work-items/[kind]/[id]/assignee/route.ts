import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { isUuid } from '@/lib/validation/issues';
import { getIssueById, setIssuePrimaryAssignee } from '@/lib/db/issues';
import { getTaskById, setTaskPrimaryAssignee } from '@/lib/db/tasks';
import { supplierExists } from '@/lib/db/suppliers';
import { actorMayAccessWorkItem } from '@/lib/auth/workItemAccess';
import { notifyIssue, notifyTask } from '@/services/notifications';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ kind: string; id: string }>;
}

// PATCH /api/work-items/[kind]/[id]/assignee  { assignee: {kind, id} | null }
// Unified module (11/10/2026) "שיוך מהיר" — single primary assignee (employee
// XOR supplier) on either issues or tasks. (tasks:edit | issues:edit)
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { kind, id } = await ctx.params;
  if (kind !== 'issue' && kind !== 'task') {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 404 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let actor: Actor;
  try {
    actor = await requirePermission(kind === 'issue' ? 'issues' : 'tasks', 'edit');
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
  const rec = (body ?? {}) as Record<string, unknown>;
  let assignee: { kind: 'user' | 'supplier'; id: string } | null = null;
  if (rec.assignee !== null && rec.assignee !== undefined) {
    const a = rec.assignee as Record<string, unknown>;
    const k = a?.kind;
    const aid = a?.id;
    if ((k !== 'user' && k !== 'supplier') || typeof aid !== 'string' || !isUuid(aid)) {
      return NextResponse.json({ error: 'invalid_assignee' }, { status: 400 });
    }
    assignee = { kind: k, id: aid };
  }
  if (assignee?.kind === 'supplier' && !(await supplierExists(assignee.id))) {
    return NextResponse.json({ error: 'supplier_not_found' }, { status: 400 });
  }

  try {
    if (kind === 'issue') {
      const existing = await getIssueById(id);
      if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      if (!actorMayAccessWorkItem(actor, existing)) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      const updated = await setIssuePrimaryAssignee(id, assignee, actor.id);
      if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      if (assignee?.kind === 'user' && assignee.id !== actor.id) {
        void notifyIssue({
          userId: assignee.id,
          type: 'issue_assigned',
          heading: 'תקלה הוקצתה לך',
          issue: { id: updated.id, title: updated.title, priority: updated.priority },
          notificationPriority: updated.priority === 'urgent' ? 'urgent' : 'normal',
          dedupeKey: `issue_assigned:${updated.id}:${assignee.id}:${Date.now()}`,
          channel: 'in_app',
          extraDetails: [{ label: 'שויך על ידי', value: actor.full_name ?? actor.username }],
        });
      }
      return NextResponse.json({ item: updated });
    }

    const existing = await getTaskById(id);
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (!actorMayAccessWorkItem(actor, existing)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const updated = await setTaskPrimaryAssignee(id, assignee, actor.id);
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (assignee?.kind === 'user' && assignee.id !== actor.id) {
      void notifyTask({
        userId: assignee.id,
        type: 'task_assigned',
        heading: 'משימה הוקצתה לך',
        task: { id: updated.id, title: updated.title, priority: updated.priority, due_date: updated.due_date },
        notificationPriority: updated.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `task_assigned:${updated.id}:${assignee.id}:${Date.now()}`,
        channel: 'in_app',
        extraDetails: [{ label: 'שויך על ידי', value: actor.full_name ?? actor.username }],
      });
    }
    return NextResponse.json({ item: updated });
  } catch (err) {
    logger.error('[PATCH /api/work-items/[kind]/[id]/assignee]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
