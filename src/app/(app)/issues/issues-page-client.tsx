'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  ISSUE_STATUSES, ISSUE_PRIORITIES, issueStatusLabel, issuePriorityLabel,
} from '@/lib/constants/issues';
import type {
  Issue, IssueKpis, IssuePriority, IssueSort, IssueStatus, IssueWithMeta, IssueSupplierOption,
} from '@/lib/types/issues';

interface Assignee {
  id: string;
  name: string;
}

export function IssuesPageClient({
  initialIssues,
  initialKpis,
  assignees,
  suppliers,
  canEdit,
}: {
  initialIssues: IssueWithMeta[];
  initialKpis: IssueKpis;
  assignees: Assignee[];
  suppliers: IssueSupplierOption[];
  canEdit: boolean;
}) {
  const searchParams = useSearchParams();
  const [issues, setIssues] = useState<IssueWithMeta[]>(initialIssues);
  const [kpis, setKpis] = useState<IssueKpis>(initialKpis);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | 'all'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [sort, setSort] = useState<IssueSort>('created_desc');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Issue | null>(null);

  const didMount = useRef(false);

  const fetchIssues = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
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
  }, [search, statusFilter, priorityFilter, assigneeFilter, supplierFilter, sort]);

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
              const d = (await r.json()) as { issue?: Issue };
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

          <Select value={statusFilter} onValueChange={(v) => { if (v) setStatusFilter(v as IssueStatus | 'all'); }}>
            <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
              <SelectValue>{(v: string | null) => (v && v !== 'all' ? issueStatusLabel(v as IssueStatus) : 'כל הסטטוסים')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">כל הסטטוסים</SelectItem>
              {ISSUE_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>

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

      {/* Table */}
      <IssuesTable issues={issues} sort={sort} onSortChange={setSort} onSelect={openEdit} />

      <IssueFormPanel
        open={formOpen}
        issue={editing}
        canEdit={canEdit}
        assignees={assignees}
        suppliers={suppliers}
        onOpenChange={setFormOpen}
        onSaved={() => void fetchIssues()}
      />
    </div>
  );
}
