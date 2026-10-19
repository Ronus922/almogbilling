'use client';

// תקלות (issues) ומשימות (tasks) — the per-screen orchestrator (12/10/2026,
// Decisions Log: "עיצוב משותף, ישויות נפרדות" cancels the 11/10/2026
// unification into one `/work` screen). One instance of this component is
// `/issues` (kind="issue"), a second, separate instance is `/tasks`
// (kind="task") — same design, same component, but each call only ever
// fetches/mutates its OWN table (src/lib/db/workItems.ts has no cross-table
// query at all anymore). Kanban is the default view (ref/issues-board.html);
// the create/edit panel is the single per-kind one (IssueFormPanel OR
// TaskFormPanel, never both — the 11/10/2026 screen held both at once).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus, Search, LayoutGrid, List as ListIcon, AlertTriangle, UserX, CalendarClock, Clock,
} from 'lucide-react';
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
import { IssueFormPanel } from '@/components/issues/issue-form-panel';
import { TaskFormPanel } from '@/components/tasks/task-form-panel';
import { RecurringSeriesList } from '@/components/recurrence/RecurringSeriesList';
import { WorkItemsBoard } from './WorkItemsBoard';
import { WorkListTable } from './WorkListTable';
import { WorkItemsArchiveTab } from './WorkItemsArchiveTab';
import { BlockedToggleDialog } from './BlockedToggleDialog';
import { BoardOrderPopover } from './BoardOrderPopover';
import { defaultBoardLaneOrder, effectiveBoardLaneIds } from '@/lib/workItems/boardOrder';
import { SUPPLIERS_LANE_ID } from '@/lib/constants/workItems';
import type { BoardLaneTarget, WorkItem, WorkItemKind, WorkItemKpis, WorkItemViewTab } from '@/lib/types/workItems';
import type { IssueWithMeta } from '@/lib/types/issues';
import type { TaskWithAssignee } from '@/lib/types/tasks';
import type { RecurringSeries } from '@/lib/db/tasks';
import type { NotifyUserContact } from '@/lib/notify/selection';

interface Assignee { id: string; name: string; hasEmail?: boolean; hasPhone?: boolean }
interface SupplierOpt { id: string; display_name: string; phone: string; mobile?: string | null; email?: string | null }

type ViewMode = 'board' | 'list';

const TITLE: Record<WorkItemKind, string> = { issue: 'תקלות', task: 'משימות' };
const NEW_LABEL: Record<WorkItemKind, string> = { issue: 'תקלה חדשה', task: 'משימה חדשה' };
const ITEM_NOUN: Record<WorkItemKind, string> = { issue: 'תקלה', task: 'משימה' };
const DELETE_NOUN: Record<WorkItemKind, string> = { issue: 'התקלה', task: 'המשימה' };
const DEEP_LINK_PARAM: Record<WorkItemKind, string> = { issue: 'issue', task: 'task' };

export function WorkEntityScreen({
  kind,
  initialItems,
  initialKpis,
  initialSeries,
  assignees,
  suppliers,
  currentUser,
  canEdit,
  canSeeReporterPhone,
}: {
  kind: WorkItemKind;
  initialItems: WorkItem[];
  initialKpis: WorkItemKpis;
  /** Tasks only — the "משימות מחזוריות" tab's rows. */
  initialSeries?: RecurringSeries[];
  assignees: Assignee[];
  suppliers: SupplierOpt[];
  currentUser: NotifyUserContact;
  canEdit: boolean;
  /** Issues only — whether the reporter's phone may show in the panel. */
  canSeeReporterPhone?: boolean;
}) {
  const router = useRouter();
  const tabs: { key: WorkItemViewTab; label: string }[] = useMemo(() => {
    const t: { key: WorkItemViewTab; label: string }[] = [{ key: 'active', label: 'פעילות' }];
    if (kind === 'task') t.push({ key: 'recurring', label: 'משימות מחזוריות' });
    t.push({ key: 'archive', label: 'ארכיון' });
    return t;
  }, [kind]);

  const [tab, setTab] = useState<WorkItemViewTab>('active');
  const [view, setView] = useState<ViewMode>('board');
  const [items, setItems] = useState<WorkItem[]>(initialItems);
  const [kpis, setKpis] = useState<WorkItemKpis>(initialKpis);
  const [archived, setArchived] = useState<WorkItem[]>([]);
  const [series, setSeries] = useState<RecurringSeries[]>(initialSeries ?? []);

  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'normal' | 'high' | 'urgent'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');

  const [panelOpen, setPanelOpen] = useState(false);
  // Set only while the create form was opened from a lane's "+" (19/10/2026).
  const [laneTarget, setLaneTarget] = useState<BoardLaneTarget | null>(null);
  const [editingIssue, setEditingIssue] = useState<IssueWithMeta | null>(null);
  const [editingTask, setEditingTask] = useState<TaskWithAssignee | null>(null);
  const [blockedDialogItem, setBlockedDialogItem] = useState<WorkItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const didMount = useRef(false);

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('kind', kind);
      params.set('tab', tab === 'recurring' ? 'active' : tab);
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
  }, [kind, tab, priorityFilter, assigneeFilter, search]);

  const fetchSeries = useCallback(async () => {
    if (kind !== 'task') return;
    try {
      const res = await fetch('/api/tasks/recurring', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { series?: RecurringSeries[] };
      setSeries(Array.isArray(data.series) ? data.series : []);
    } catch { /* non-fatal */ }
  }, [kind]);

  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (tab === 'recurring') { void fetchSeries(); return; }
    void fetchItems();
  }, [tab, priorityFilter, assigneeFilter, search, fetchItems, fetchSeries]);

  // Live updates without a manual refresh (13/10/2026, decision 1): poll every
  // 15s, skipped while the tab is hidden (document.hidden), and also fired
  // right away on refocus/tab-visible — the same `tick` covers both so a card
  // created while the viewer was away still shows up within 15s of coming
  // back. `pollTick` additionally drives the open panel's own comment refresh
  // (IssueFormPanel/TaskFormPanel's `refreshSignal` — never the editable
  // fields, see those components).
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    function tick() {
      if (document.hidden) return;
      setPollTick((t) => t + 1);
      if (tab === 'active') void fetchItems();
      else if (tab === 'recurring') void fetchSeries();
    }
    const interval = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [tab, fetchItems, fetchSeries]);

  // "התאמת לוח" (decision 2) — the viewer's saved lane set for this module
  // (employee uuids + optionally SUPPLIERS_LANE_ID), in order. null = never
  // customized: the board falls back to the default algorithm (decision 3)
  // computed from the current `items` below.
  const [boardOrder, setBoardOrder] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/work-items/${kind}/board-preferences`, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { employeeIds: string[] | null };
        if (alive) setBoardOrder(data.employeeIds);
      } catch { /* non-fatal — falls back to the default algorithm */ }
    })();
    return () => { alive = false; };
  }, [kind]);

  async function saveBoardOrder(next: string[]) {
    setBoardOrder(next);
    try {
      const res = await fetch(`/api/work-items/${kind}/board-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employeeIds: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      toast.error(`שמירת התאמת הלוח נכשלה: ${(err as Error).message}`);
    }
  }

  // Default lane set (decision 3; extended 14/10/2026 to the suppliers lane)
  // when the viewer never customized — pure function, see
  // src/lib/workItems/boardOrder.ts for the algorithm + its test.
  const defaultBoardOrder = useMemo(
    () => defaultBoardLaneOrder(items, assignees),
    [items, assignees],
  );

  // The effective lane order — employee uuids plus, optionally,
  // SUPPLIERS_LANE_ID for "ספקים" (14/10/2026, "התאמת לוח — ספקים + בחירה
  // מפורשת גוברת", decision 1 — explicit selection wins for every lane).
  // src/lib/workItems/boardOrder.ts for the full rule + its test.
  const boardLaneIds = effectiveBoardLaneIds(boardOrder, defaultBoardOrder, assignees);
  // The employee portion only — unrelated to lane visibility, this is also
  // the assignee-picker roster handed to every card (WorkItemsBoard/
  // WorkItemCard), so it must stay exactly what it was before suppliers
  // could appear in boardLaneIds: employee objects, never the sentinel.
  const boardEmployees = useMemo(
    () => boardLaneIds
      .filter((id) => id !== SUPPLIERS_LANE_ID)
      .map((id) => assignees.find((a) => a.id === id))
      .filter((a): a is Assignee => !!a),
    [boardLaneIds, assignees],
  );

  const openById = useCallback(async (id: string) => {
    try {
      if (kind === 'issue') {
        const res = await fetch(`/api/issues/${id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('פתיחת התקלה נכשלה');
        const data = (await res.json()) as { issue: IssueWithMeta };
        setEditingIssue(data.issue);
      } else {
        const res = await fetch(`/api/tasks/${id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('פתיחת המשימה נכשלה');
        const data = (await res.json()) as { task: TaskWithAssignee };
        setEditingTask(data.task);
      }
      setPanelOpen(true);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [kind]);

  function openCreate(target: BoardLaneTarget | null) {
    setEditingIssue(null);
    setEditingTask(null);
    setLaneTarget(target);
    setPanelOpen(true);
  }

  function openItem(item: WorkItem) {
    setLaneTarget(null);
    void openById(item.id);
  }

  // Deep link: /issues?issue=<id> or /tasks?task=<id> — the SAME param each
  // screen's legacy full page already answered to before 11/10/2026, so every
  // previously-sent link (notifications, reminders, calendar, overview,
  // search) keeps working once its generator points back here (12/10/2026).
  const searchParams = useSearchParams();
  useEffect(() => {
    const id = searchParams.get(DEEP_LINK_PARAM[kind]);
    if (id) void openById(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAssign(item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) {
    const prevItems = items;
    const prevKpis = kpis;
    // "ללא שיוך" KPI follows the move at once (the strip counters derive from
    // `items`); the next poll/refetch replaces it with the server's number.
    const delta = (assignee ? 0 : 1) - (item.assignee ? 0 : 1);
    if (delta !== 0) setKpis((k) => ({ ...k, unassigned: Math.max(0, k.unassigned + delta) }));
    setItems((curr) => curr.map((i) => (i.id === item.id ? { ...i, assignee: assignee ? { kind: assignee.kind, id: assignee.id, display_name: (assignee.kind === 'user' ? assignees.find((a) => a.id === assignee.id)?.name : suppliers.find((s) => s.id === assignee.id)?.display_name) ?? '—' } : null } : i)));
    try {
      const res = await fetch(`/api/work-items/${kind}/${item.id}/assignee`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignee }),
      });
      if (!res.ok) throw new Error('השיוך נכשל');
      toast.success(assignee ? 'שויך בהצלחה' : 'השיוך בוטל');
    } catch (err) {
      setItems(prevItems);
      setKpis(prevKpis);
      toast.error((err as Error).message);
    }
  }

  async function handleMarkDone(item: WorkItem) {
    const prevItems = items;
    try {
      const res = await fetch(`/api/work-items/${kind}/${item.id}/status`, { method: 'PATCH', credentials: 'include' });
      if (!res.ok) throw new Error('הסימון נכשל');
      toast.success('סומן כבוצע', { description: 'ניתן לבטל מהודעה זו', action: { label: 'בטל', onClick: () => setItems(prevItems) } });
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function handleBlockedChange(item: WorkItem, blocked: boolean, reason: string | null) {
    setItems((curr) => curr.map((i) => (i.id === item.id ? { ...i, blocked, blocked_reason: reason } : i)));
  }

  async function handleReorder(item: WorkItem, beforeId: string | null) {
    try {
      const res = await fetch(`/api/work-items/${kind}/${item.id}/move`, {
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
      const res = await fetch(`/api/work-items/${kind}/${item.id}/restore`, { method: 'PATCH', credentials: 'include' });
      if (!res.ok) throw new Error('השחזור נכשל');
      toast.success('הפריט שוחזר לרשימה הפעילה');
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/${kind === 'issue' ? 'issues' : 'tasks'}/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('המחיקה נכשלה');
      toast.success('נמחק בהצלחה');
      setDeleteTarget(null);
      setPanelOpen(false);
      void fetchItems();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const kpiCards = useMemo(() => ([
    { key: 'urgent' as const, title: 'דחופות פעילות', value: kpis.urgentActive, icon: AlertTriangle, tone: 'red' as const },
    { key: 'unassigned' as const, title: 'ללא שיוך', value: kpis.unassigned, icon: UserX, tone: 'purple' as const },
    { key: 'due_today' as const, title: 'לטיפול היום', value: kpis.dueToday, icon: CalendarClock, tone: 'cyan' as const },
    { key: 'overdue' as const, title: 'באיחור', value: kpis.overdue, icon: Clock, tone: 'amber' as const },
  ]), [kpis]);

  function applyKpiFilter(key: 'urgent' | 'unassigned' | 'due_today' | 'overdue') {
    if (key === 'urgent') setPriorityFilter('urgent');
    if (key === 'unassigned') setAssigneeFilter('unassigned');
  }

  function closePanel() {
    setPanelOpen(false);
    router.replace(kind === 'issue' ? '/issues' : '/tasks');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold text-ink">{TITLE[kind]}</h1>
        {canEdit && (
          <Button onClick={() => openCreate(null)} className="gap-1.5">
            <Plus className="h-4 w-4" /> {NEW_LABEL[kind]}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${tab === t.key ? 'bg-brand text-white' : 'bg-line-soft text-ink-2 hover:bg-line'}`}
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
              <button type="button" onClick={() => setView('board')} className={`hidden h-8 w-8 place-items-center rounded-md lg:grid ${view === 'board' ? 'bg-brand text-white' : 'text-ink-ghost'}`} aria-label="קנבן">
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setView('list')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'list' ? 'bg-brand text-white' : 'text-ink-ghost'}`} aria-label="רשימה">
                <ListIcon className="h-4 w-4" />
              </button>
            </div>

            {view === 'board' && (
              <div className="hidden lg:block">
                <BoardOrderPopover
                  employees={assignees}
                  visibleIds={boardLaneIds}
                  onChange={(next) => void saveBoardOrder(next)}
                />
              </div>
            )}

            <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as typeof priorityFilter)}>
              <SelectTrigger className="h-10 w-32"><SelectValue>{priorityFilter === 'all' ? 'דחיפות: הכל' : priorityFilter === 'urgent' ? 'דחופה' : priorityFilter === 'high' ? 'גבוהה' : 'רגילה'}</SelectValue></SelectTrigger>
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
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`חיפוש ${kind === 'issue' ? 'תקלה' : 'משימה'}...`} className="h-10 pr-9" />
            </div>
          </div>

          {view === 'board' ? (
            <>
              {/* Board is desktop-only (lg+) — list below lg even while 'board' is selected. */}
              <div className="hidden lg:block">
                <WorkItemsBoard
                  items={items}
                  canEdit={canEdit}
                  employees={boardEmployees}
                  suppliers={suppliers}
                  laneOrder={boardLaneIds}
                  noun={ITEM_NOUN[kind]}
                  onOpen={openItem}
                  onAssign={handleAssign}
                  onAddToLane={openCreate}
                  onReorder={handleReorder}
                  onReorderLanes={(next) => void saveBoardOrder(next)}
                  onMarkDone={handleMarkDone}
                  onBlockedClick={setBlockedDialogItem}
                  onDelete={setDeleteTarget}
                />
              </div>
              <div className="lg:hidden">
                <WorkListTable
                  kind={kind}
                  items={items}
                  canEdit={canEdit}
                  employees={assignees}
                  suppliers={suppliers}
                  onOpen={openItem}
                  onAssign={handleAssign}
                  onReorder={handleReorder}
                  onMarkDone={handleMarkDone}
                  onBlockedClick={setBlockedDialogItem}
                  onDelete={setDeleteTarget}
                />
              </div>
            </>
          ) : (
            <WorkListTable
              kind={kind}
              items={items}
              canEdit={canEdit}
              employees={assignees}
              suppliers={suppliers}
              onOpen={openItem}
              onAssign={handleAssign}
              onReorder={handleReorder}
              onMarkDone={handleMarkDone}
              onBlockedClick={setBlockedDialogItem}
              onDelete={setDeleteTarget}
            />
          )}
        </>
      )}

      {tab === 'recurring' && kind === 'task' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            כאן מוגדרות המשימות החוזרות. כל משימה מחזורית היא שורה אחת, המוצגת ברשימה הפעילה במועד הפתוח הנוכחי — השלמתה מעבירה אותה אוטומטית למופע הבא.
          </div>
          <RecurringSeriesList series={series} onSelect={(id) => void openById(id)} onTogglePaused={handleTogglePaused} />
        </div>
      )}

      {tab === 'archive' && (
        <WorkItemsArchiveTab items={archived} canEdit={canEdit} onRestore={handleRestore} onOpen={openItem} />
      )}

      {kind === 'issue' ? (
        <IssueFormPanel
          open={panelOpen}
          issue={editingIssue}
          canEdit={canEdit}
          canSeeReporterPhone={!!canSeeReporterPhone}
          assignees={assignees}
          suppliers={suppliers}
          currentUser={currentUser}
          laneTarget={laneTarget}
          onOpenChange={(o) => { if (!o) closePanel(); else setPanelOpen(o); }}
          onSaved={() => { setPanelOpen(false); void fetchItems(); }}
          onDelete={editingIssue && canEdit ? () => setDeleteTarget({ id: editingIssue.id }) : undefined}
          refreshSignal={pollTick}
        />
      ) : (
        <TaskFormPanel
          open={panelOpen}
          task={editingTask}
          canEdit={canEdit}
          assignees={assignees}
          suppliers={suppliers}
          currentUser={currentUser}
          laneTarget={laneTarget}
          onOpenChange={(o) => { if (!o) closePanel(); else setPanelOpen(o); }}
          onSaved={() => { setPanelOpen(false); void fetchItems(); void fetchSeries(); }}
          onDelete={editingTask && canEdit ? () => setDeleteTarget({ id: editingTask.id }) : undefined}
          refreshSignal={pollTick}
        />
      )}

      {blockedDialogItem && (
        <BlockedToggleDialog
          open
          onOpenChange={(o) => { if (!o) setBlockedDialogItem(null); }}
          kind={blockedDialogItem.kind}
          id={blockedDialogItem.id}
          currentlyBlocked={blockedDialogItem.blocked}
          currentReason={blockedDialogItem.blocked_reason}
          onDone={(blocked, reason) => {
            handleBlockedChange(blockedDialogItem, blocked, reason);
            setBlockedDialogItem(null);
          }}
        />
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את {DELETE_NOUN[kind]}?</AlertDialogTitle>
            <AlertDialogDescription>הפעולה בלתי הפיכה.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} disabled={deleting} className="bg-destructive text-white hover:bg-destructive/90">
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
