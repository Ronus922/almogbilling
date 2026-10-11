'use client';

// Unified "תקלות ומשימות" screen (11/10/2026) — orchestrator: tabs (פעילות |
// משימות מחזוריות | ארכיון), KPI bar, toolbar (list/board toggle, group-by,
// filters, search), and the per-kind create/edit panels (reused as-is —
// IssueFormPanel / TaskFormPanel keep their existing multi-assignee section;
// the new single-primary assignee is a separate, simpler concept used only by
// quick-assign/the board — see Decisions Log 11/10/2026).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus, Search, LayoutGrid, List as ListIcon, AlertTriangle, UserX, CalendarClock, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { KpiCard } from '@/components/KpiCard';
import { IssueFormPanel } from '@/components/issues/issue-form-panel';
import { TaskFormPanel } from '@/components/tasks/task-form-panel';
import { RecurringSeriesList } from '@/components/recurrence/RecurringSeriesList';
import { WorkItemsList } from '@/components/work-items/WorkItemsList';
import { WorkItemsBoard } from '@/components/work-items/WorkItemsBoard';
import { WorkItemsArchiveTab } from '@/components/work-items/WorkItemsArchiveTab';
import { todayInJerusalem } from '@/lib/dates';
import type { WorkItem, WorkItemGroupBy, WorkItemKpis, WorkItemViewTab } from '@/lib/types/workItems';
import type { IssueWithMeta } from '@/lib/types/issues';
import type { TaskWithAssignee } from '@/lib/types/tasks';
import type { RecurringSeries } from '@/lib/db/tasks';
import type { NotifyUserContact } from '@/lib/notify/selection';

interface Assignee { id: string; name: string; hasEmail?: boolean; hasPhone?: boolean }
interface SupplierOpt { id: string; display_name: string; phone: string; mobile?: string | null; email?: string | null }

type ViewMode = 'list' | 'board';

const TABS: { key: WorkItemViewTab; label: string }[] = [
  { key: 'active', label: 'פעילות' },
  { key: 'recurring', label: 'משימות מחזוריות' },
  { key: 'archive', label: 'ארכיון' },
];

export function WorkPageClient({
  initialItems,
  initialKpis,
  assignees,
  suppliers,
  currentUser,
  canEditIssues,
  canEditTasks,
  canViewIssues,
  canViewTasks,
  canSeeReporterPhone,
}: {
  initialItems: WorkItem[];
  initialKpis: WorkItemKpis;
  assignees: Assignee[];
  suppliers: SupplierOpt[];
  currentUser: NotifyUserContact;
  canEditIssues: boolean;
  canEditTasks: boolean;
  canViewIssues: boolean;
  canViewTasks: boolean;
  canSeeReporterPhone: boolean;
}) {
  const today = todayInJerusalem();
  const [tab, setTab] = useState<WorkItemViewTab>('active');
  const [view, setView] = useState<ViewMode>('list');
  const [groupBy, setGroupBy] = useState<WorkItemGroupBy>('status');
  const [items, setItems] = useState<WorkItem[]>(initialItems);
  const [kpis, setKpis] = useState<WorkItemKpis>(initialKpis);
  const [archived, setArchived] = useState<WorkItem[]>([]);
  const [series, setSeries] = useState<RecurringSeries[]>([]);

  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'issue' | 'task'>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'normal' | 'high' | 'urgent'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');

  const [issuePanelOpen, setIssuePanelOpen] = useState(false);
  const [editingIssue, setEditingIssue] = useState<IssueWithMeta | null>(null);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskWithAssignee | null>(null);

  const didMount = useRef(false);

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('tab', tab === 'recurring' ? 'active' : tab);
      if (kindFilter !== 'all') params.set('kind', kindFilter);
      if (priorityFilter !== 'all') params.set('priority', priorityFilter);
      if (assigneeFilter !== 'all') params.set('assigneeUserId', assigneeFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('kpis', '1');
      const res = await fetch(`/api/work-items?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: WorkItem[]; kpis?: WorkItemKpis };
      if (tab === 'archive') setArchived(Array.isArray(data.items) ? data.items : []);
      else setItems(Array.isArray(data.items) ? data.items : []);
      if (data.kpis) setKpis(data.kpis);
    } catch (err) {
      toast.error(`טעינת הרשימה נכשלה: ${(err as Error).message}`);
    }
  }, [tab, kindFilter, priorityFilter, assigneeFilter, search]);

  const fetchSeries = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks/recurring', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { series?: RecurringSeries[] };
      setSeries(Array.isArray(data.series) ? data.series : []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (tab === 'recurring') { void fetchSeries(); return; }
    void fetchItems();
  }, [tab, kindFilter, priorityFilter, assigneeFilter, search, fetchItems, fetchSeries]);

  useEffect(() => { if (tab === 'recurring' && series.length === 0) void fetchSeries(); }, [tab, series.length, fetchSeries]);

  async function openItem(item: WorkItem) {
    try {
      if (item.kind === 'issue') {
        const res = await fetch(`/api/issues/${item.id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('פתיחת התקלה נכשלה');
        const data = (await res.json()) as { issue: IssueWithMeta };
        setEditingIssue(data.issue);
        setIssuePanelOpen(true);
      } else {
        const res = await fetch(`/api/tasks/${item.id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('פתיחת המשימה נכשלה');
        const data = (await res.json()) as { task: TaskWithAssignee };
        setEditingTask(data.task);
        setTaskPanelOpen(true);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleAssign(item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) {
    const prevItems = items;
    setItems((curr) => curr.map((i) => (i.id === item.id && i.kind === item.kind ? { ...i, assignee: assignee ? { kind: assignee.kind, id: assignee.id, display_name: (assignee.kind === 'user' ? assignees.find((a) => a.id === assignee.id)?.name : suppliers.find((s) => s.id === assignee.id)?.display_name) ?? '—' } : null } : i)));
    try {
      const res = await fetch(`/api/work-items/${item.kind}/${item.id}/assignee`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignee }),
      });
      if (!res.ok) throw new Error('השיוך נכשל');
      toast.success(assignee ? 'שויך בהצלחה' : 'השיוך בוטל');
    } catch (err) {
      setItems(prevItems);
      toast.error((err as Error).message);
    }
  }

  async function handleAdvanceStatus(item: WorkItem) {
    const prevItems = items;
    try {
      const res = await fetch(`/api/work-items/${item.kind}/${item.id}/status`, {
        method: 'PATCH',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('עדכון הסטטוס נכשל');
      toast.success('הסטטוס עודכן', { description: 'ניתן לבטל מהודעה זו', action: { label: 'בטל', onClick: () => setItems(prevItems) } });
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleReorder(item: WorkItem, beforeId: string | null) {
    try {
      const res = await fetch(`/api/work-items/${item.kind}/${item.id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ before_id: beforeId }),
      });
      if (!res.ok) throw new Error('הסידור נכשל');
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleTogglePaused(id: string, paused: boolean) {
    try {
      const res = await fetch(`/api/tasks/${id}/recurrence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: paused ? 'pause' : 'resume' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void fetchSeries();
    } catch (err) {
      toast.error(`עדכון הסדרה נכשל: ${(err as Error).message}`);
    }
  }

  async function handleRestore(item: WorkItem) {
    try {
      const res = await fetch(`/api/work-items/${item.kind}/${item.id}/restore`, { method: 'PATCH', credentials: 'include' });
      if (!res.ok) throw new Error('השחזור נכשל');
      toast.success('הפריט שוחזר לרשימה הפעילה');
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const canEditAny = canEditIssues || canEditTasks;
  const hasSupplierItems = items.some((i) => i.assignee?.kind === 'supplier');

  const kpiCards = useMemo(() => ([
    { key: 'urgent' as const, title: 'דחופות פעילות', value: kpis.urgentActive, icon: AlertTriangle, tone: 'red' as const },
    { key: 'unassigned' as const, title: 'ללא שיוך', value: kpis.unassigned, icon: UserX, tone: 'purple' as const },
    { key: 'due_today' as const, title: 'לטיפול היום', value: kpis.dueToday, icon: CalendarClock, tone: 'cyan' as const },
    { key: 'overdue' as const, title: 'באיחור', value: kpis.overdue, icon: Clock, tone: 'amber' as const },
  ]), [kpis]);

  function applyKpiFilter(key: 'urgent' | 'unassigned' | 'due_today' | 'overdue') {
    if (key === 'urgent') setPriorityFilter('urgent');
    if (key === 'unassigned') setAssigneeFilter('unassigned');
    // due_today / overdue are date-based — surfaced via sort, not a filter param here.
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold text-ink">תקלות ומשימות</h1>
        {canEditAny && (
          <div className="flex items-center gap-2">
            {canEditIssues && (
              <Button onClick={() => { setEditingIssue(null); setIssuePanelOpen(true); }} className="gap-1.5">
                <Plus className="h-4 w-4" /> תקלה חדשה
              </Button>
            )}
            {canEditTasks && (
              <Button variant="outline" onClick={() => { setEditingTask(null); setTaskPanelOpen(true); }} className="gap-1.5">
                <Plus className="h-4 w-4" /> משימה חדשה
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'active' && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {kpiCards.map((k) => (
              <button key={k.key} type="button" onClick={() => applyKpiFilter(k.key)} className="text-start">
                <KpiCard title={k.title} value={String(k.value)} tone={k.tone} icon={k.icon} />
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-line bg-white p-1">
              <button type="button" onClick={() => setView('list')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'list' ? 'bg-blue-600 text-white' : 'text-ink-ghost'}`}>
                <ListIcon className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setView('board')} className={`hidden h-8 w-8 place-items-center rounded-md lg:grid ${view === 'board' ? 'bg-blue-600 text-white' : 'text-ink-ghost'}`}>
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>

            {view === 'list' && (
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as WorkItemGroupBy)}>
                <SelectTrigger className="h-10 w-40"><SelectValue>{groupBy === 'status' ? 'קיבוץ: סטטוס' : groupBy === 'assignee' ? 'קיבוץ: עובד' : 'קיבוץ: דחיפות'}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="status">קיבוץ: סטטוס</SelectItem>
                  <SelectItem value="assignee">קיבוץ: עובד</SelectItem>
                  <SelectItem value="priority">קיבוץ: דחיפות</SelectItem>
                </SelectContent>
              </Select>
            )}

            <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
              <SelectTrigger className="h-10 w-28"><SelectValue>{kindFilter === 'all' ? 'סוג: הכל' : kindFilter === 'issue' ? 'תקלות' : 'משימות'}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">סוג: הכל</SelectItem>
                <SelectItem value="issue">תקלות</SelectItem>
                <SelectItem value="task">משימות</SelectItem>
              </SelectContent>
            </Select>

            <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as typeof priorityFilter)}>
              <SelectTrigger className="h-10 w-32"><SelectValue>{priorityFilter === 'all' ? 'דחיפות: הכל' : priorityFilter}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">דחיפות: הכל</SelectItem>
                <SelectItem value="urgent">דחופה</SelectItem>
                <SelectItem value="high">גבוהה</SelectItem>
                <SelectItem value="normal">רגילה</SelectItem>
              </SelectContent>
            </Select>

            <Select value={assigneeFilter} onValueChange={(v) => setAssigneeFilter(v ?? 'all')}>
              <SelectTrigger className="h-10 w-36"><SelectValue>{assigneeFilter === 'all' ? 'עובד: הכל' : assigneeFilter === 'unassigned' ? 'ללא שיוך' : assignees.find((a) => a.id === assigneeFilter)?.name ?? 'עובד'}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">עובד: הכל</SelectItem>
                <SelectItem value="unassigned">ללא שיוך</SelectItem>
                {assignees.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>

            <div className="relative min-w-[180px] flex-1">
              <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-ghost" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="חיפוש…" className="h-10 pr-9" />
            </div>
          </div>

          {view === 'board' ? (
            <>
              {/* Board is desktop-only (lg+) — list below lg even while 'board' is selected. */}
              <div className="hidden lg:block">
                <WorkItemsBoard
                  items={items}
                  canEdit={canEditAny}
                  employees={assignees}
                  hasSupplierItems={hasSupplierItems}
                  onOpen={openItem}
                  onAssign={handleAssign}
                  onReorder={handleReorder}
                  onAdvanceStatus={handleAdvanceStatus}
                />
              </div>
              <div className="lg:hidden">
                <WorkItemsList
                  items={items}
                  today={today}
                  canEdit={canEditAny}
                  groupBy={groupBy}
                  employees={assignees}
                  suppliers={suppliers}
                  onOpen={openItem}
                  onAssign={handleAssign}
                  onAdvanceStatus={handleAdvanceStatus}
                />
              </div>
            </>
          ) : (
            <WorkItemsList
              items={items}
              today={today}
              canEdit={canEditAny}
              groupBy={groupBy}
              employees={assignees}
              suppliers={suppliers}
              onOpen={openItem}
              onAssign={handleAssign}
              onAdvanceStatus={handleAdvanceStatus}
            />
          )}
        </>
      )}

      {tab === 'recurring' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            כאן מוגדרות המשימות החוזרות. כל משימה מחזורית היא שורה אחת, המוצגת ברשימה הפעילה במועד הפתוח הנוכחי — השלמתה מעבירה אותה אוטומטית למופע הבא.
          </div>
          <RecurringSeriesList series={series} onSelect={async (id) => {
            const res = await fetch(`/api/tasks/${id}`, { credentials: 'include' });
            if (!res.ok) return;
            const data = (await res.json()) as { task: TaskWithAssignee };
            setEditingTask(data.task);
            setTaskPanelOpen(true);
          }} onTogglePaused={handleTogglePaused} />
        </div>
      )}

      {tab === 'archive' && (
        <WorkItemsArchiveTab items={archived} canEdit={canEditAny} onRestore={handleRestore} onOpen={openItem} />
      )}

      {canViewIssues && (
        <IssueFormPanel
          open={issuePanelOpen}
          issue={editingIssue}
          canEdit={canEditIssues}
          canSeeReporterPhone={canSeeReporterPhone}
          assignees={assignees}
          suppliers={suppliers}
          currentUser={currentUser}
          onOpenChange={setIssuePanelOpen}
          onSaved={() => { setIssuePanelOpen(false); void fetchItems(); }}
        />
      )}
      {canViewTasks && (
        <TaskFormPanel
          open={taskPanelOpen}
          task={editingTask}
          canEdit={canEditTasks}
          assignees={assignees}
          suppliers={suppliers}
          currentUser={currentUser}
          onOpenChange={setTaskPanelOpen}
          onSaved={() => { setTaskPanelOpen(false); void fetchItems(); void fetchSeries(); }}
        />
      )}
    </div>
  );
}
