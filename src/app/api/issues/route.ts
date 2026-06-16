import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listIssues, createIssue, getIssueKpis } from '@/lib/db/issues';
import { coerceIssueInput } from '@/lib/validation/issues';
import { notifyIssue, createNotification } from '@/services/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import type {
  Issue,
  IssuePriority,
  IssueSort,
  IssueStatus,
  IssueWritableFields,
} from '@/lib/types/issues';

export const runtime = 'nodejs';

/**
 * Notify every active admin (super_admin + admin) — except the reporter — that a
 * new issue was opened. Complements the per-assignee `issue_assigned`: this is
 * the "תקלה חדשה נפתחה" broadcast. Best-effort, deduped per (issue, admin);
 * never throws (fire-and-forget after the issue is already persisted).
 */
async function notifyAdminsOfIssueReported(issue: Issue, actorId: string): Promise<void> {
  try {
    const desc = issue.description?.trim();
    const message = desc ? `${issue.title} — ${desc.slice(0, 120)}` : issue.title;
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      if (admin.id === actorId) continue;
      await createNotification({
        userId: admin.id,
        type: 'issue_reported',
        title: 'תקלה חדשה נפתחה',
        message,
        sourceModule: 'issues',
        sourceEntityType: 'Issue',
        sourceEntityId: issue.id,
        actionUrl: `/issues?issue=${issue.id}`,
        priority: 'high',
        dedupeKey: `issue_reported:${issue.id}:${admin.id}`,
      });
    }
  } catch (err) {
    console.error('[issues] issue_reported notification failed', err);
  }
}

const STATUSES: readonly IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES: readonly IssuePriority[] = ['low', 'normal', 'high', 'urgent'];
const SORTS: readonly IssueSort[] = ['created_desc', 'priority_desc', 'updated_desc', 'status_asc'];

// GET /api/issues?status&priority&assignedTo&search&sort&kpis  (issues:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('issues', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const statusRaw = sp.get('status')?.trim();
  const status =
    statusRaw && statusRaw !== 'all' && STATUSES.includes(statusRaw as IssueStatus)
      ? (statusRaw as IssueStatus)
      : undefined;

  const priorityRaw = sp.get('priority')?.trim();
  const priority =
    priorityRaw && priorityRaw !== 'all' && PRIORITIES.includes(priorityRaw as IssuePriority)
      ? (priorityRaw as IssuePriority)
      : undefined;

  const assignedToRaw = sp.get('assignedTo')?.trim();
  const assignedTo = assignedToRaw && assignedToRaw !== 'all' ? assignedToRaw : undefined;

  const search = sp.get('search')?.trim() || undefined;

  const sortRaw = sp.get('sort')?.trim();
  const sort = sortRaw && SORTS.includes(sortRaw as IssueSort) ? (sortRaw as IssueSort) : undefined;

  const items = await listIssues({ status, priority, assignedTo, search, sort });

  if (sp.get('kpis') === '1') {
    const kpis = await getIssueKpis();
    return NextResponse.json({ items, kpis });
  }
  return NextResponse.json({ items });
}

// POST /api/issues  (issues:edit — viewer may also create per spec)
export async function POST(req: NextRequest) {
  // Per spec: a viewer may create + view issues. So we gate create on 'view'
  // (any authenticated user with the issues module). Edits to existing issues
  // still require 'edit' (see PATCH /api/issues/[id]).
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'view');
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

  const result = coerceIssueInput(bodyRec, 'create');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  try {
    const issue = await createIssue(
      result.fields as Partial<IssueWritableFields> & { title: string },
      actor.id,
      actor.full_name ?? actor.username,
    );

    // "תקלה חדשה נפתחה" → every active admin except the reporter. Fire-and-forget
    // after the real insert so the response isn't blocked by the fan-out.
    void notifyAdminsOfIssueReported(issue, actor.id);

    // Assignment notification (only when assigned to someone other than the creator).
    if (issue.assigned_to_user_id && issue.assigned_to_user_id !== actor.id) {
      await notifyIssue({
        userId: issue.assigned_to_user_id,
        type: 'issue_assigned',
        heading: 'תקלה חדשה הוקצתה לך',
        issue: { id: issue.id, title: issue.title, priority: issue.priority },
        notificationPriority: issue.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `issue_assigned:${issue.id}:${issue.assigned_to_user_id}`,
        extraDetails: [{ label: 'דווח על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    return NextResponse.json({ issue }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    if (e.code === '23514') {
      return NextResponse.json({ error: 'invalid_value' }, { status: 400 });
    }
    console.error('[POST /api/issues]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
