'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Plus, Search, LayoutGrid, List, ListTodo, AlarmClock, CircleCheckBig, Repeat,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { KpiCard } from '@/components/KpiCard';
import { TasksKanban } from '@/components/tasks/tasks-kanban';
import { TasksTable } from '@/components/tasks/tasks-table';
import { TaskFormPanel } from '@/components/tasks/task-form-panel';
import { RecurringSeriesList } from '@/components/recurrence/RecurringSeriesList';
import { cn } from '@/lib/utils';
import { urgentFirst } from '@/lib/priority-sort';
import {
  TASK_STATUSES, TASK_PRIORITIES, taskStatusLabel, taskPriorityLabel,
  ACTIVE_TASK_STATUSES, isCompletedTaskStatus,
} from '@/lib/constants/tasks';
import type {
  TaskKpis, TaskPriority, TaskSort, TaskStatus, TaskWithAssignee,
} from '@/lib/types/tasks';
import type { RecurringSeries } from '@/lib/db/tasks';
import type { SupplierOption } from '@/lib/types/assignee';
import type { NotifyUserContact } from '@/lib/notify/selection';

type ViewMode = 'kanban' | 'table';

interface Assignee {
  id: string;
  name: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
}

export function TasksPageClient({
  initialTasks,
  initialKpis,
  initialSeries,
  assignees,
  suppliers,
  currentUser,
  canEdit,
}: {
  initialTasks: TaskWithAssignee[];
  initialKpis: TaskKpis;
  initialSeries: RecurringSeries[];
  assignees: Assignee[];
  suppliers: SupplierOption[];
  currentUser: NotifyUserContact;
  canEdit: boolean;
}) {
  const searchParams = useSearchParams();
  const [tasks, setTasks] = useState<TaskWithAssignee[]>(initialTasks);
  const [kpis, setKpis] = useState<TaskKpis>(initialKpis);
  const [series, setSeries] = useState<RecurringSeries[]>(initialSeries);
  const [view, setView] = useState<ViewMode>('kanban');
  const [tab, setTab] = useState<'active' | 'completed' | 'recurring'>('active');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  // Default: due date asc — combined with the urgent-first table ordering this
  // is "urgent above all, then due date ascending".
  const [sort, setSort] = useState<TaskSort>('due_asc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TaskWithAssignee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskWithAssignee | null>(null);

  const didMount = useRef(false);

  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      // status is NOT sent to the API — the active/completed tab + the status
      // dropdown both filter client-side, so the tab counts stay accurate.
      if (priorityFilter !== 'all') params.set('priority', priorityFilter);
      if (assigneeFilter !== 'all') params.set('assignedTo', assigneeFilter);
      if (supplierFilter !== 'all') params.set('supplier_id', supplierFilter);
      params.set('sort', sort);
      params.set('kpis', '1');
      const res = await fetch(`/api/tasks?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: TaskWithAssignee[]; kpis?: TaskKpis };
      setTasks(Array.isArray(data.items) ? data.items : []);
      if (data.kpis) setKpis(data.kpis);
    } catch (err) {
      toast.error(`טעינת המשימות נכשלה: ${(err as Error).message}`);
    }
  }, [search, priorityFilter, assigneeFilter, supplierFilter, sort]);

  // Recurring series for the "מחזוריות" tab. Filter-independent (its own loader),
  // refreshed after a save/delete. Next-occurrence sorting is done server-side.
  const fetchSeries = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks/recurring', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { series?: RecurringSeries[] };
      setSeries(Array.isArray(data.series) ? data.series : []);
    } catch {
      /* non-fatal */
    }
  }, []);

  // Active / completed partition (client-side — "filter only", no new status).
  const activeTasks = useMemo(() => tasks.filter((t) => !isCompletedTaskStatus(t.status)), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((t) => isCompletedTaskStatus(t.status)), [tasks]);
  const tabTasks = tab === 'active' ? activeTasks : completedTasks;
  // The status dropdown narrows further, but only in table view (the kanban
  // always shows its full set of columns).
  const shown = useMemo(() => {
    if (view === 'table' && statusFilter !== 'all') return tabTasks.filter((t) => t.status === statusFilter);
    return tabTasks;
  }, [tabTasks, statusFilter, view]);

  // Initial data is server-rendered; refetch when filters/sort change.
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    const t = setTimeout(() => { void fetchTasks(); }, 300);
    return () => clearTimeout(t);
  }, [fetchTasks]);

  // Deep link: ?task=<id> opens the panel for that task.
  useEffect(() => {
    const id = searchParams.get('task');
    if (id) {
      const found = initialTasks.find((t) => t.id === id);
      if (found) { setEditing(found); setFormOpen(true); }
      else {
        void (async () => {
          try {
            const r = await fetch(`/api/tasks/${id}`, { credentials: 'include' });
            if (r.ok) {
              const d = (await r.json()) as { task?: TaskWithAssignee };
              if (d.task) { setEditing(d.task); setFormOpen(true); }
            }
          } catch { /* ignore */ }
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(t: TaskWithAssignee) {
    setEditing(t);
    setFormOpen(true);
  }
  // Open a task by id (recurrence tab row → the series' template task). Use the
  // already-loaded row when present, else fetch it.
  function openTaskById(id: string) {
    const found = tasks.find((t) => t.id === id);
    if (found) { setEditing(found); setFormOpen(true); return; }
    void (async () => {
      try {
        const r = await fetch(`/api/tasks/${id}`, { credentials: 'include' });
        if (!r.ok) return;
        const d = (await r.json()) as { task?: TaskWithAssignee };
        if (d.task) { setEditing(d.task); setFormOpen(true); }
      } catch { /* ignore */ }
    })();
  }
  // After any mutation refresh both the task list/KPIs and the series tab.
  function refreshAll() {
    void fetchTasks();
    void fetchSeries();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/tasks/${deleteTarget.id}`, { method: 'DELETE', credentials: 'include' });
      if (res.status !== 204 && !res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('המשימה נמחקה');
      if (editing?.id === deleteTarget.id) setFormOpen(false);
      setDeleteTarget(null);
      refreshAll();
    } catch (err) {
      toast.error(`מחיקה נכשלה: ${(err as Error).message}`);
    }
  }

  // Persist a priority lane's full order after a kanban drag — covers cross-lane
  // moves (re-prioritise) AND within-lane manual reorder. The board's axis is
  // priority; status is unchanged here. Renumber sort_order = position per id.
  async function handleReorder(priority: TaskPriority, orderedIds: string[]) {
    const prev = tasks;
    const orderMap = new Map(orderedIds.map((id, i) => [id, i] as const));
    setTasks(tasks.map((t) =>
      orderMap.has(t.id) ? { ...t, priority, sort_order: orderMap.get(t.id)! } : t,
    ));
    try {
      const items = orderedIds.map((id, i) => ({ id, priority, sort_order: i }));
      const r = await fetch('/api/tasks/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ items }),
      });
      if (!r.ok) throw new Error('שמירת הסידור נכשלה');
      void fetchTasks();
    } catch (e) {
      setTasks(prev);
      toast.error((e as Error).message);
    }
  }

  // Drop onto the "בוצע" lane → complete the task via the [id] PATCH (so completed_at
  // is stamped and reminders are cleared). It then leaves the active board for the
  // "הושלמו" tab. Optimistically flip its status so it disappears immediately.
  async function handleComplete(task: TaskWithAssignee) {
    const prev = tasks;
    setTasks(tasks.map((t) => (t.id === task.id ? { ...t, status: 'done' as TaskStatus } : t)));
    try {
      const r = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'done' }),
      });
      if (!r.ok) throw new Error('סימון כבוצע נכשל');
      void fetchTasks();
    } catch (e) {
      setTasks(prev);
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">משימות</h1>
          <span className="text-sm text-muted-foreground tabular-nums">{tasks.length} משימות</span>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> משימה חדשה
            </Button>
          )}
        </div>
      </div>

      {/* KPI bar */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="משימות פתוחות" value={String(kpis.open)} tone="purple" icon={ListTodo} />
        <KpiCard title="באיחור" value={String(kpis.overdue)} tone="red" icon={AlarmClock} />
        <KpiCard title="הושלמו החודש" value={String(kpis.doneThisMonth)} tone="green" icon={CircleCheckBig} />
      </div>

      {/* Active / completed tabs (filter only — terminal statuses move here) */}
      <div className="flex flex-wrap gap-2">
        {([
          { key: 'active', label: 'פעילות', count: activeTasks.length, icon: null },
          { key: 'completed', label: 'הושלמו', count: completedTasks.length, icon: null },
          { key: 'recurring', label: 'מחזוריות', count: series.length, icon: Repeat },
        ] as const).map((t) => {
          const on = tab === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); setStatusFilter('all'); }}
              className={cn(
                'inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors',
                on ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {t.label}
              <span className={cn(
                'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums',
                on ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700',
              )}>
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Toolbar: view toggle + filters — hidden on the recurrence tab */}
      {tab !== 'recurring' && (
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* View toggle — completed tab is table-only */}
        {tab === 'active' ? (
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setView('kanban')}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors cursor-pointer',
                view === 'kanban' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              <LayoutGrid className="h-4 w-4" /> קנבן
            </button>
            <button
              type="button"
              onClick={() => setView('table')}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors cursor-pointer',
                view === 'table' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              <List className="h-4 w-4" /> טבלה
            </button>
          </div>
        ) : (
          <div />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש משימה…"
              className="h-10 w-full ps-9 sm:w-56"
            />
          </div>

          {/* Status filter — table view of the active tab only (completed tab and
              the kanban already scope their statuses). */}
          {view === 'table' && tab === 'active' && (
            <Select value={statusFilter} onValueChange={(v) => { if (v) setStatusFilter(v as TaskStatus | 'all'); }}>
              <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
                <SelectValue>{(v: string | null) => (v && v !== 'all' ? taskStatusLabel(v as TaskStatus) : 'כל הסטטוסים')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הסטטוסים</SelectItem>
                {TASK_STATUSES.filter((s) => ACTIVE_TASK_STATUSES.includes(s.value)).map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={priorityFilter} onValueChange={(v) => { if (v) setPriorityFilter(v as TaskPriority | 'all'); }}>
            <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
              <SelectValue>{(v: string | null) => (v && v !== 'all' ? taskPriorityLabel(v as TaskPriority) : 'כל העדיפויות')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל העדיפויות</SelectItem>
              {TASK_PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={assigneeFilter} onValueChange={(v) => { if (v) setAssigneeFilter(v); }}>
            <SelectTrigger className="h-10 w-40 data-[size=default]:h-10">
              <SelectValue>
                {(v: string | null) => {
                  if (!v || v === 'all') return 'כל המשויכים';
                  return assignees.find((a) => a.id === v)?.name ?? 'משויך';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל המשויכים</SelectItem>
              {assignees.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={supplierFilter} onValueChange={(v) => { if (v) setSupplierFilter(v); }}>
            <SelectTrigger className="h-10 w-40 data-[size=default]:h-10">
              <SelectValue>
                {(v: string | null) => {
                  if (!v || v === 'all') return 'כל הספקים';
                  return suppliers.find((s) => s.id === v)?.display_name ?? 'ספק';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הספקים</SelectItem>
              {suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      )}

      {/* Board / Table / Series — completed is always a table; recurring is its own list */}
      {tab === 'recurring' ? (
        <RecurringSeriesList series={series} onSelect={openTaskById} />
      ) : tab === 'active' && view === 'kanban' ? (
        <TasksKanban tasks={shown} canEdit={canEdit} onSelect={openEdit} onReorder={handleReorder} onComplete={handleComplete} onDelete={canEdit ? setDeleteTarget : undefined} />
      ) : (
        <TasksTable tasks={urgentFirst(shown)} sort={sort} onSortChange={setSort} onSelect={openEdit} onDelete={canEdit ? setDeleteTarget : undefined} />
      )}

      <TaskFormPanel
        open={formOpen}
        task={editing}
        canEdit={canEdit}
        assignees={assignees}
        suppliers={suppliers}
        currentUser={currentUser}
        onOpenChange={setFormOpen}
        onSaved={refreshAll}
        onDelete={canEdit && editing ? () => setDeleteTarget(editing) : undefined}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את המשימה?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `המשימה "${deleteTarget.title}" תועבר לארכיון. ניתן לשחזר אותה בהמשך.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-white hover:bg-destructive/90">
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
