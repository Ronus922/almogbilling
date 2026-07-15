'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Wrench, MapPin, Play, Check, AlertTriangle, CircleCheckBig } from 'lucide-react';
import { IssueFormPanel } from './issue-form-panel';
import { WorkerIssueDetail } from './worker-issue-detail';
import { cn } from '@/lib/utils';
import {
  ISSUE_STATUS_BADGE, ISSUE_PRIORITY_BADGE,
  issueStatusLabel, issuePriorityLabel, isCompletedIssueStatus,
} from '@/lib/constants/issues';
import type { IssueStatus, IssueWithMeta } from '@/lib/types/issues';
import type { NotifyUserContact } from '@/lib/notify/selection';

interface Props {
  /** The worker's OWN issues — already filtered server-side by assignedTo. */
  issues: IssueWithMeta[];
  userName: string;
  roleName: string;
  /** Rendered on the server so the date can't drift between server and client. */
  todayLabel: string;
  currentUser: NotifyUserContact;
}

/**
 * The field-worker screen for /issues (ref/pms-worker-ref.html, screen 2).
 *
 * A worker gets one question answered — "what is on me right now, and what do I
 * press" — so this is a plain card list of their OWN active issues with exactly
 * two moves: start it, finish it. No kanban, no filters, no table.
 *
 * Deliberately NOT built (ponytail):
 *  - No tab bar. The ref's משימות/תחזוקה tabs are just navigation, and the app
 *    already has it — the sidebar/MobileNav is permission-filtered, so a worker
 *    sees exactly משימות + תקלות and nothing else. A second nav would be a
 *    duplicate that drifts.
 *  - No נוכחות (attendance) tab — no such module exists in this app.
 *  - No "ממתין לחלקים" / "ממתין לספק" buttons — there are no such statuses, and
 *    a button that silently does nothing is worse than a missing one.
 *  - No completed list. The banner carries the count; that is what the ref does.
 *
 * Colour notes, where DESIGN.md overrides the ref (DESIGN.md wins on conflict):
 *  - Card side-stripe: ref's orange #f97316 is not a §2 tone → amber-500, which
 *    reads as the same orange and matches the `high` priority badge.
 *  - Number bubble: ref's indigo → the §9b avatar pattern (blue-100/blue-700).
 *  - Badges come from the SHARED ISSUE_*_BADGE maps, so this screen can never
 *    drift from the kanban/table.
 */
export function WorkerIssuesView({ issues, userName, roleName, todayLabel, currentUser }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<IssueWithMeta[]>(issues);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const active = useMemo(() => rows.filter((i) => !isCompletedIssueStatus(i.status)), [rows]);
  const doneCount = rows.length - active.length;

  const detailIssue = detailId ? rows.find((i) => i.id === detailId) ?? null : null;

  /** Keep the list card in sync when the detail screen changes a status. */
  function applyStatus(id: string, status: IssueStatus) {
    setRows((curr) => curr.map((i) => (i.id === id ? { ...i, status } : i)));
  }

  if (detailIssue) {
    return (
      <WorkerIssueDetail
        issue={detailIssue}
        onBack={() => setDetailId(null)}
        onStatusChange={applyStatus}
      />
    );
  }

  /**
   * The only mutation on this screen. Both moves are a plain status PATCH on the
   * existing route — no new endpoint, no new status:
   *   התחל טיפול → in_progress
   *   השלם       → closed  (NOT resolved: resolving requires resolution notes,
   *                        which this screen has no field for. Same choice the
   *                        kanban's "בוצע" lane already makes.)
   */
  async function setStatus(issue: IssueWithMeta, status: IssueStatus, okMessage: string) {
    const prev = rows;
    setBusyId(issue.id);
    setRows((curr) => curr.map((i) => (i.id === issue.id ? { ...i, status } : i)));
    try {
      const r = await fetch(`/api/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error('עדכון התקלה נכשל');
      toast.success(okMessage);
    } catch (e) {
      setRows(prev); // roll the optimistic flip back
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Banner — a header surface, not a primary action, so the deeper blue-800
          of the ref is kept (blue-600 stays reserved for the actions below). */}
      <div className="flex items-center justify-between gap-4 rounded-2xl bg-blue-800 p-6 text-white">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold">התקלות שלי</h1>
          <p className="mt-1 text-sm text-white/80">{todayLabel}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="rounded-full bg-white/20 px-2.5 py-0.5 font-bold tabular-nums">
              {active.length}
            </span>
            <span className="text-white/85">פעילות</span>
            <span className="rounded-full bg-white/20 px-2.5 py-0.5 font-bold tabular-nums">
              {doneCount}
            </span>
            <span className="text-white/85">הושלמו</span>
          </div>
          <p className="mt-2 text-xs text-white/70">{userName} · {roleName}</p>
        </div>
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/15">
          <Wrench className="h-6 w-6" />
        </span>
      </div>

      {/* Report a fault — the ref's red "תקלה" tab. blue-600 per DESIGN.md §2
          (red is destructive-only; reporting a fault destroys nothing). */}
      <button
        type="button"
        onClick={() => setReportOpen(true)}
        className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-blue-700"
      >
        <AlertTriangle className="h-5 w-5" />
        דווח על תקלה
      </button>

      {active.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600">
            <CircleCheckBig className="h-6 w-6" />
          </span>
          <p className="mt-3 text-base font-bold text-slate-900">אין תקלות פתוחות</p>
          <p className="mt-1 text-sm text-slate-500">
            {doneCount > 0 ? 'סיימת הכל. כל הכבוד.' : 'לא שויכו אליך תקלות כרגע.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {active.map((issue, idx) => {
            const inProgress = issue.status === 'in_progress';
            const busy = busyId === issue.id;
            return (
              <article
                key={issue.id}
                role="button"
                tabIndex={0}
                onClick={() => setDetailId(issue.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(issue.id); } }}
                className={cn(
                  'cursor-pointer rounded-[22px] border-s-[5px] bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.06)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.1)]',
                  inProgress ? 'border-s-blue-600' : 'border-s-amber-500',
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-blue-100 text-[17px] font-extrabold text-blue-700 tabular-nums">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[19px] font-extrabold leading-tight text-slate-900">
                      {issue.title}
                    </h2>
                    {issue.description && (
                      <p className="mt-1 line-clamp-2 text-[13px] text-slate-500">
                        {issue.description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-[13px] font-semibold text-slate-400 tabular-nums">
                    {idx + 1}/{active.length}
                  </span>
                </div>

                {issue.target_label && (
                  <p className="mt-3 flex items-center gap-1.5 text-[15px] font-semibold text-slate-700">
                    <MapPin className="h-4 w-4 shrink-0 text-slate-400" />
                    {issue.target_label}
                  </p>
                )}

                {/* Shared badge maps — never restyled locally, or this screen
                    drifts from the kanban. */}
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', ISSUE_STATUS_BADGE[issue.status])}>
                    {issueStatusLabel(issue.status)}
                  </span>
                  <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', ISSUE_PRIORITY_BADGE[issue.priority])}>
                    {issuePriorityLabel(issue.priority)}
                  </span>
                </div>

                {inProgress ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); void setStatus(issue, 'closed', 'התקלה הושלמה'); }}
                    className="mt-4 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                  >
                    <Check className="h-5 w-5" />
                    {busy ? 'מעדכן…' : 'השלם'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); void setStatus(issue, 'in_progress', 'התקלה בטיפול'); }}
                    className="mt-4 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                  >
                    <Play className="h-5 w-5" />
                    {busy ? 'מעדכן…' : 'התחל טיפול'}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Reuse the real form — same fields, same validation, same endpoint. The
          assignee/supplier pickers get empty lists on purpose: a worker holds no
          `suppliers` permission, so their page must not ship the supplier roster
          (names, phones, emails) to the browser. Assignment is the manager's job;
          the field stays, its options are simply none. */}
      <IssueFormPanel
        open={reportOpen}
        issue={null}
        canEdit
        assignees={[]}
        suppliers={[]}
        currentUser={currentUser}
        onOpenChange={setReportOpen}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
