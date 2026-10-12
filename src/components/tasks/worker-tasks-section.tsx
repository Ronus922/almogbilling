'use client';

// Field-worker tasks section (unified module, 11/10/2026) — sits below the
// EXISTING, unchanged WorkerIssuesView on the unified /work screen. Workers
// had NO scoped tasks view before this (src/app/api/tasks/** enforced no
// row-level boundary — see Decisions Log 11/10/2026), so this is new ground,
// not a capability to preserve; kept deliberately simple (ponytail): a plain
// card list with the two moves a worker has, no media/comments (tasks never
// had an image/video capability to preserve in the first place).

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Play, Check, CircleCheckBig, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  STATUS_BADGE as TASK_STATUS_BADGE, PRIORITY_BADGE as TASK_PRIORITY_BADGE,
  taskStatusLabel, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type { TaskStatus, TaskWithAssignee } from '@/lib/types/tasks';

interface Props {
  tasks: TaskWithAssignee[];
}

function isOpenTaskStatus(s: TaskStatus): boolean {
  return s === 'open' || s === 'in_progress';
}

export function WorkerTasksSection({ tasks }: Props) {
  const [rows, setRows] = useState<TaskWithAssignee[]>(tasks);
  const [busyId, setBusyId] = useState<string | null>(null);

  const active = useMemo(() => rows.filter((t) => isOpenTaskStatus(t.status)), [rows]);
  const doneCount = rows.length - active.length;

  async function setStatus(task: TaskWithAssignee, status: TaskStatus, okMessage: string) {
    const prev = rows;
    setBusyId(task.id);
    setRows((curr) => curr.map((t) => (t.id === task.id ? { ...t, status } : t)));
    try {
      const r = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error('עדכון המשימה נכשל');
      toast.success(okMessage);
    } catch (e) {
      setRows(prev);
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h2 className="px-1 text-lg font-extrabold text-slate-900">המשימות שלי</h2>

      {active.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600">
            <CircleCheckBig className="h-6 w-6" />
          </span>
          <p className="mt-3 text-base font-bold text-slate-900">אין משימות פתוחות</p>
          <p className="mt-1 text-sm text-slate-500">
            {doneCount > 0 ? 'סיימת הכל. כל הכבוד.' : 'לא שויכו אליך משימות כרגע.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {active.map((task) => {
            const inProgress = task.status === 'in_progress';
            const busy = busyId === task.id;
            return (
              <article
                key={task.id}
                className={cn(
                  'rounded-[22px] border-s-[5px] bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.06)]',
                  inProgress ? 'border-s-blue-600' : 'border-s-amber-500',
                )}
              >
                <h3 className="text-[17px] font-extrabold leading-tight text-slate-900">{task.title}</h3>
                {task.description && (
                  <p className="mt-1 line-clamp-2 text-[13px] text-slate-500">{task.description}</p>
                )}
                {task.due_date && (
                  <p className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold text-slate-600">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span dir="ltr" className="tabular-nums">{task.due_date}</span>
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', TASK_STATUS_BADGE[task.status])}>
                    {taskStatusLabel(task.status)}
                  </span>
                  <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', TASK_PRIORITY_BADGE[task.priority])}>
                    {taskPriorityLabel(task.priority)}
                  </span>
                </div>
                {inProgress ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setStatus(task, 'done', 'המשימה הושלמה')}
                    className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                  >
                    <Check className="h-5 w-5" />
                    {busy ? 'מעדכן…' : 'השלם'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setStatus(task, 'in_progress', 'המשימה בטיפול')}
                    className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
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
    </div>
  );
}
