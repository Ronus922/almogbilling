import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { issueScopeUserId } from '@/lib/auth/issueAccess';
import { listIssues, createIssue, getIssueKpis } from '@/lib/db/issues';
import { supplierExists } from '@/lib/db/suppliers';
import { createReminder } from '@/lib/db/reminders';
import { coerceIssueInput } from '@/lib/validation/issues';
// Generic, entity-agnostic reminders coercion (reused from the tasks module).
import { coerceReminders } from '@/lib/validation/tasks';
import { coerceAssignees } from '@/lib/validation/assignee';
import { notifyIssue, createNotification } from '@/services/notifications';
import { dispatchCreateNotifications, buildMatrixRecipients } from '@/services/createNotify';
import { coerceNotifySelection } from '@/lib/notify/selection';
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
const PRIORITIES: readonly IssuePriority[] = ['normal', 'high', 'urgent'];
const SORTS: readonly IssueSort[] = ['created_desc', 'priority_desc', 'updated_desc', 'status_asc'];

// GET /api/issues?status&priority&assignedTo&search&sort&kpis  (issues:view)
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'view');
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

  // Field-worker isolation: a scoped worker is FORCED to their own issues — the
  // client-supplied `assignedTo` is ignored for them (it is a UI filter, never a
  // trust boundary). Managers keep the client filter. Same rule scopes the KPIs.
  const scope = issueScopeUserId(actor);
  const clientAssignedTo = sp.get('assignedTo')?.trim();
  const assignedTo = scope ?? (clientAssignedTo && clientAssignedTo !== 'all' ? clientAssignedTo : undefined);

  const search = sp.get('search')?.trim() || undefined;

  const sortRaw = sp.get('sort')?.trim();
  const sort = sortRaw && SORTS.includes(sortRaw as IssueSort) ? (sortRaw as IssueSort) : undefined;

  const items = await listIssues({ status, priority, assignedTo, search, sort });

  if (sp.get('kpis') === '1') {
    const kpis = await getIssueKpis(scope);
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
    const issue = await createIssue(
      result.fields as Partial<IssueWritableFields> & { title: string },
      assignees,
      actor.id,
      actor.full_name ?? actor.username,
    );

    const userIds = issue.assignees.map((a) => a.user_id).filter((v): v is string => v !== null);

    // Reminders → ONE row per reminder, owned by the reporter. The engine fans
    // out to the issue's CURRENT user-assignees at fire time (falling back to
    // this owner when there are none), so a single reminder is never duplicated
    // per assignee.
    if (reminders && reminders.ok) {
      for (const r of reminders.reminders) {
        await createReminder({
          entityType: 'issue',
          entityId: issue.id,
          userId: actor.id,
          remindAt: r.remind_at,
          channels: r.channels,
        });
      }
    }

    // "תקלה חדשה נפתחה" → every active admin except the reporter (fire-and-forget).
    void notifyAdminsOfIssueReported(issue, actor.id);

    // In-app assignment bell → each user assignee other than the reporter
    // (channel:'in_app' suppresses the auto-email; external is matrix-driven).
    for (const uid of userIds) {
      if (uid === actor.id) continue;
      await notifyIssue({
        userId: uid,
        type: 'issue_assigned',
        heading: 'תקלה חדשה הוקצתה לך',
        issue: { id: issue.id, title: issue.title, priority: issue.priority },
        notificationPriority: issue.priority === 'urgent' ? 'urgent' : 'normal',
        dedupeKey: `issue_assigned:${issue.id}:${uid}`,
        channel: 'in_app',
        extraDetails: [{ label: 'דווח על ידי', value: actor.full_name ?? actor.username }],
      });
    }

    // External notifications (email / WhatsApp) — ONLY the creator's matrix picks.
    const recipients = buildMatrixRecipients({
      selection: coerceNotifySelection(bodyRec.notify),
      meUserId: actor.id,
      assignees: issue.assignees,
      meMessage: `דיווחת על תקלה חדשה: ${issue.title}`,
      assigneeMessage: () => `הוקצתה לך תקלה חדשה: ${issue.title}`,
    });
    if (recipients.length > 0) {
      void dispatchCreateNotifications({
        title: `תקלה: ${issue.title}`,
        actionUrl: `/issues?issue=${issue.id}`,
        recipients,
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
