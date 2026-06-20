'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Plus, Search, AlertTriangle, Flame, CircleCheckBig,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { KpiCard } from '@/app/(app)/dashboard/components/KpiCard';
import { IssuesTable } from '@/components/issues/issues-table';
import { IssueFormPanel } from '@/components/issues/issue-form-panel';
import { cn } from '@/lib/utils';
import { urgentFirst } from '@/lib/priority-sort';
import {
  ISSUE_STATUSES, ISSUE_PRIORITIES, issueStatusLabel, issuePriorityLabel,
  ACTIVE_ISSUE_STATUSES, isCompletedIssueStatus,
} from '@/lib/constants/issues';
import type {
  IssueKpis, IssuePriority, IssueSort, IssueStatus, IssueWithMeta,
} from '@/lib/types/issues';
import type { SupplierOption } from '@/lib/types/assignee';
import type { NotifyUserContact } from '@/lib/notify/selection';

interface Assignee {
  id: string;
  name: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
}

export function IssuesPageClient({
  initialIssues,
  initialKpis,
  assignees,
  suppliers,
  currentUser,
  canEdit,
}: {
  initialIssues: IssueWithMeta[];
  initialKpis: IssueKpis;
  assignees: Assignee[];
  suppliers: SupplierOption[];
  currentUser: NotifyUserContact;
  canEdit: boolean;
}) {
  const searchParams = useSearchParams();
  const [issues, setIssues] = useState<IssueWithMeta[]>(initialIssues);
  const [kpis, setKpis] = useState<IssueKpis>(initialKpis);

  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | 'all'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [sort, setSort] = useState<IssueSort>('created_desc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IssueWithMeta | null>(null);

  const didMount = useRef(false);

  const fetchIssues = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      // status filtered client-side (active/completed tab + dropdown) so tab
      // counts stay accurate.
      if (priorityFilter !== 'all') params.set('priority', priorityFilter);
      if (assigneeFilter !== 'all') params.set('assignedTo', assigneeFilter);
      if (supplierFilter !== 'all') params.set('supplier_id', supplierFilter);
      params.set('sort', sort);
      params.set('kpis', '1');
      const res = await fetch(`/api/issues?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: IssueWithMeta[]; kpis?: IssueKpis };
      setIssues(Array.isArray(data.items) ? data.items : []);
      if (data.kpis) setKpis(data.kpis);
    } catch (err) {
      toast.error(`טעינת התקלות נכשלה: ${(err as Error).message}`);
    }
  }, [search, priorityFilter, assigneeFilter, supplierFilter, sort]);

  // Active / completed partition (client-side — "filter only", no new status).
  const activeIssues = useMemo(() => issues.filter((i) => !isCompletedIssueStatus(i.status)), [issues]);
  const completedIssues = useMemo(() => issues.filter((i) => isCompletedIssueStatus(i.status)), [issues]);
  const tabIssues = tab === 'active' ? activeIssues : completedIssues;
  const shown = useMemo(() => {
    if (statusFilter !== 'all') return tabIssues.filter((i) => i.status === statusFilter);
    return tabIssues;
  }, [tabIssues, statusFilter]);

  // Initial data is server-rendered; refetch when filters/sort change.
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    const t = setTimeout(() => { void fetchIssues(); }, 300);
    return () => clearTimeout(t);
  }, [fetchIssues]);

  // Deep link: ?issue=<id> opens the panel for that issue.
  useEffect(() => {
    const id = searchParams.get('issue');
    if (id) {
      const found = initialIssues.find((i) => i.id === id);
      if (found) { setEditing(found); setFormOpen(true); }
      else {
        void (async () => {
          try {
            const r = await fetch(`/api/issues/${id}`, { credentials: 'include' });
            if (r.ok) {
              const d = (await r.json()) as { issue?: IssueWithMeta };
              if (d.issue) { setEditing(d.issue); setFormOpen(true); }
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
  function openEdit(i: IssueWithMeta) {
    setEditing(i);
    setFormOpen(true);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">תקלות</h1>
          <span className="text-sm text-muted-foreground tabular-nums">{issues.length} תקלות</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Per spec: viewers may also report an issue. */}
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> תקלה חדשה
          </Button>
        </div>
      </div>

      {/* KPI bar */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="תקלות פתוחות" value={String(kpis.open)} tone="orange" icon={AlertTriangle} />
        <KpiCard title="דחופות" value={String(kpis.urgent)} tone="red" icon={Flame} />
        <KpiCard title="נפתרו החודש" value={String(kpis.resolvedThisMonth)} tone="green" icon={CircleCheckBig} />
      </div>

      {/* Active / completed tabs (filter only — terminal statuses move here) */}
      <div className="flex flex-wrap gap-2">
        {([
          { key: 'active', label: 'פעילות', count: activeIssues.length },
          { key: 'completed', label: 'הושלמו', count: completedIssues.length },
        ] as const).map((t) => {
          const on = tab === t.key;
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

      {/* Toolbar: search + filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-end">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש תקלה…"
              className="h-10 w-full ps-9 sm:w-56"
            />
          </div>

          {/* Status filter — active tab only (completed tab is the two terminal statuses). */}
          {tab === 'active' && (
            <Select value={statusFilter} onValueChange={(v) => { if (v) setStatusFilter(v as IssueStatus | 'all'); }}>
              <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
                <SelectValue>{(v: string | null) => (v && v !== 'all' ? issueStatusLabel(v as IssueStatus) : 'כל הסטטוסים')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הסטטוסים</SelectItem>
                {ISSUE_STATUSES.filter((s) => ACTIVE_ISSUE_STATUSES.includes(s.value)).map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={priorityFilter} onValueChange={(v) => { if (v) setPriorityFilter(v as IssuePriority | 'all'); }}>
            <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
              <SelectValue>{(v: string | null) => (v && v !== 'all' ? issuePriorityLabel(v as IssuePriority) : 'כל הדחיפויות')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הדחיפויות</SelectItem>
              {ISSUE_PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
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

      {/* Table — urgent first, then the selected sort within each group.
          (Issues have no due-date field, so "due date asc" is N/A here.) */}
      <IssuesTable issues={urgentFirst(shown)} sort={sort} onSortChange={setSort} onSelect={openEdit} />

      <IssueFormPanel
        open={formOpen}
        issue={editing}
        canEdit={canEdit}
        assignees={assignees}
        suppliers={suppliers}
        currentUser={currentUser}
        onOpenChange={setFormOpen}
        onSaved={() => void fetchIssues()}
      />
    </div>
  );
}
