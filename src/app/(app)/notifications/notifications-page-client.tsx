'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, ChevronLeft, CheckCheck, Eraser } from 'lucide-react';
import { toast } from 'sonner';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { NotificationsTable } from '@/components/notifications/notifications-table';
import {
  SOURCE_MODULE_LABEL, PRIORITY_LABEL,
  type SourceModule, type Priority,
} from '@/lib/notifications/registry';
import type { Notification } from '@/lib/types/tasks';

type ReadState = 'all' | 'unread' | 'read';

const MODULE_OPTIONS = Object.entries(SOURCE_MODULE_LABEL) as [SourceModule, string][];
const PRIORITY_OPTIONS = Object.entries(PRIORITY_LABEL) as [Priority, string][];

export function NotificationsPageClient({
  initialItems,
  initialTotal,
  pageSize,
}: {
  initialItems: Notification[];
  initialTotal: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);

  const [moduleFilter, setModuleFilter] = useState<SourceModule | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [readFilter, setReadFilter] = useState<ReadState>('all');

  const didMount = useRef(false);

  const fetchPage = useCallback(async (targetPage: number) => {
    try {
      const params = new URLSearchParams();
      if (moduleFilter !== 'all') params.set('module', moduleFilter);
      if (priorityFilter !== 'all') params.set('priority', priorityFilter);
      if (readFilter === 'unread') params.set('unread', '1');
      else if (readFilter === 'read') params.set('unread', '0');
      params.set('page', String(targetPage));
      const res = await fetch(`/api/notifications/list?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: Notification[]; total?: number; page?: number };
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(typeof data.total === 'number' ? data.total : 0);
      setPage(typeof data.page === 'number' ? data.page : targetPage);
    } catch (err) {
      toast.error(`טעינת ההתראות נכשלה: ${(err as Error).message}`);
    }
  }, [moduleFilter, priorityFilter, readFilter]);

  // Initial data is server-rendered; refetch (page 1) when filters change.
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    void fetchPage(1);
  }, [fetchPage]);

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true, read_at: n.read_at ?? new Date().toISOString() })));
    try {
      const r = await fetch('/api/notifications/read-all', { method: 'PATCH', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('סומן כנקרא');
      void fetchPage(page);
    } catch (err) {
      toast.error(`פעולה נכשלה: ${(err as Error).message}`);
    }
  }

  async function clearAll() {
    try {
      const r = await fetch('/api/notifications/clear-all', { method: 'PATCH', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('הרשימה נוקתה');
      // Soft-cleared rows leave every view → reload from page 1.
      void fetchPage(1);
    } catch (err) {
      toast.error(`פעולה נכשלה: ${(err as Error).message}`);
    }
  }

  function onSelect(n: Notification) {
    if (!n.is_read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      void fetch(`/api/notifications/${n.id}/read`, { method: 'PATCH', credentials: 'include' }).catch(() => {});
    }
    if (n.action_url) router.push(n.action_url);
  }

  // Soft-clear ONE notification — optimistic remove, then reconcile from server.
  async function onClear(n: Notification) {
    setItems((prev) => prev.filter((x) => x.id !== n.id));
    setTotal((t) => Math.max(0, t - 1));
    try {
      const r = await fetch(`/api/notifications/${n.id}/clear`, { method: 'PATCH', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('ההתראה נמחקה');
      void fetchPage(page);
    } catch (err) {
      toast.error(`מחיקה נכשלה: ${(err as Error).message}`);
      void fetchPage(page); // resync on failure (undo the optimistic removal)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">התראות</h1>
          <span className="text-sm text-muted-foreground tabular-nums">{total} התראות</span>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-50 cursor-pointer"
          >
            <CheckCheck className="h-4 w-4" /> סמן הכל כנקרא
          </button>
          <button
            type="button"
            onClick={() => void clearAll()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 cursor-pointer"
          >
            <Eraser className="h-4 w-4" /> נקה הכל
          </button>
        </div>
      </div>

      {/* Toolbar: filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={moduleFilter} onValueChange={(v) => { if (v) setModuleFilter(v as SourceModule | 'all'); }}>
          <SelectTrigger className="h-10 w-40 data-[size=default]:h-10">
            <SelectValue>
              {(v: string | null) => (v && v !== 'all' ? (SOURCE_MODULE_LABEL[v as SourceModule] ?? v) : 'כל המקורות')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל המקורות</SelectItem>
            {MODULE_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={(v) => { if (v) setPriorityFilter(v as Priority | 'all'); }}>
          <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
            <SelectValue>
              {(v: string | null) => (v && v !== 'all' ? (PRIORITY_LABEL[v as Priority] ?? v) : 'כל העדיפויות')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל העדיפויות</SelectItem>
            {PRIORITY_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={readFilter} onValueChange={(v) => { if (v) setReadFilter(v as ReadState); }}>
          <SelectTrigger className="h-10 w-36 data-[size=default]:h-10">
            <SelectValue>
              {(v: string | null) =>
                v === 'unread' ? 'לא נקראו' : v === 'read' ? 'נקראו' : 'הכל'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">הכל</SelectItem>
            <SelectItem value="unread">לא נקראו</SelectItem>
            <SelectItem value="read">נקראו</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <NotificationsTable items={items} onSelect={onSelect} onClear={onClear} />

      {/* Pagination (logical-RTL chevrons) */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 tabular-nums">עמוד {page} מתוך {totalPages}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { if (page > 1) void fetchPage(page - 1); }}
              disabled={page <= 1}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md border px-2 cursor-pointer', page <= 1 && 'pointer-events-none opacity-50')}
            >
              <ChevronRight className="h-4 w-4" />
              הקודם
            </button>
            <button
              type="button"
              onClick={() => { if (page < totalPages) void fetchPage(page + 1); }}
              disabled={page >= totalPages}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md border px-2 cursor-pointer', page >= totalPages && 'pointer-events-none opacity-50')}
            >
              הבא
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
