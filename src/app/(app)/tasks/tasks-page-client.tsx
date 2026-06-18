'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Plus, Search, LayoutGrid, List, ListTodo, AlarmClock, CircleCheckBig,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { KpiCard } from '@/app/(app)/dashboard/components/KpiCard';
import { TasksKanban } from '@/components/tasks/tasks-kanban';
import { TasksTable } from '@/components/tasks/tasks-table';
import { TaskFormPanel } from '@/components/tasks/task-form-panel';
import { cn } from '@/lib/utils';
import {
  TASK_STATUSES, TASK_PRIORITIES, taskStatusLabel, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type {
  Task, TaskKpis, TaskPriority, TaskSort, TaskStatus, TaskWithAssignee,
} from '@/lib/types/tasks';
import type { SupplierOption } from '@/lib/types/assignee';

type ViewMode = 'kanban' | 'table';

interface Assignee {
  id: string;
  name: string;
}

export function TasksPageClient({
  initialTasks,
  initialKpis,
  assignees,
  suppliers,
  canEdit,
}: {
  initialTasks: TaskWithAssignee[];
  initialKpis: TaskKpis;
  assignees: Assignee[];
  suppliers: SupplierOption[];
  canEdit: boolean;
}) {
  const searchParams = useSearchParams();
  const [tasks, setTasks] = useState<TaskWithAssignee[]>(initialTasks);
  const [kpis, setKpis] = useState<TaskKpis>(initialKpis);
  const [view, setView] = useState<ViewMode>('kanban');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [sort, setSort] = useState<TaskSort>('created_desc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);

  const didMount = useRef(false);

  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
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
  }, [search, statusFilter, priorityFilter, assigneeFilter, supplierFilter, sort]);

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
              const d = (await r.json()) as { task?: Task };
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

  async function handleMove(taskId: string, toStatus: TaskStatus, toIndex: number) {
    // Optimistic: update local state immediately.
    const prev = tasks;
    const moved = tasks.find((t) => t.id === taskId);
    if (!moved) return;
    const next = tasks.map((t) =>
      t.id === taskId ? { ...t, status: toStatus, sort_order: toIndex } : t,
    );
    setTasks(next);
    try {
      const r = await fetch('/api/tasks/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ items: [{ id: taskId, status: toStatus, sort_order: toIndex }] }),
      });
      if (!r.ok) throw new Error('שמירת המיקום נכשלה');
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

      {/* Toolbar: view toggle + filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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

          {/* Status filter — only meaningful in table view; kanban shows all columns. */}
          {view === 'table' && (
            <Select value={statusFilter} onValueChange={(v) => { if (v) setStatusFilter(v as TaskStatus | 'all'); }}>
              <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
                <SelectValue>{(v: string | null) => (v && v !== 'all' ? taskStatusLabel(v as TaskStatus) : 'כל הסטטוסים')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הסטטוסים</SelectItem>
                {TASK_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
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

      {/* Board / Table */}
      {view === 'kanban' ? (
        <TasksKanban tasks={tasks} canEdit={canEdit} onSelect={openEdit} onMove={handleMove} />
      ) : (
        <TasksTable tasks={tasks} sort={sort} onSortChange={setSort} onSelect={openEdit} />
      )}

      <TaskFormPanel
        open={formOpen}
        task={editing}
        canEdit={canEdit}
        assignees={assignees}
        suppliers={suppliers}
        onOpenChange={setFormOpen}
        onSaved={() => void fetchTasks()}
      />
    </div>
  );
}
