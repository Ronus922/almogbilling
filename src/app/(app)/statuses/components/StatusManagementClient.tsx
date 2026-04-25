'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  Plus, Search, Pencil, Trash2, Lock, Sliders,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { StatusAdminRow } from '@/lib/db/statuses';
import { StatusFormSheet } from './StatusFormSheet';
import { LinkedDebtorsSheet } from './LinkedDebtorsSheet';
import { DeleteStatusDialog } from './DeleteStatusDialog';

export function StatusManagementClient({
  initialStatuses,
}: {
  initialStatuses: StatusAdminRow[];
}) {
  const router = useRouter();
  const [statuses, setStatuses] = useState<StatusAdminRow[]>(initialStatuses);
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StatusAdminRow | null>(null);

  const [linkedFor, setLinkedFor] = useState<StatusAdminRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StatusAdminRow | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return statuses.filter((s) => {
      if (activeOnly && !s.is_active) return false;
      if (q) {
        const inName = s.name.toLowerCase().includes(q);
        const inDesc = (s.description ?? '').toLowerCase().includes(q);
        if (!inName && !inDesc) return false;
      }
      return true;
    });
  }, [statuses, query, activeOnly]);

  async function refetch() {
    try {
      const res = await fetch('/api/statuses?include=all', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatuses(await res.json());
    } catch (err) {
      toast.error(`רענון נכשל: ${(err as Error).message}`);
    }
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(s: StatusAdminRow) {
    setEditing(s);
    setFormOpen(true);
  }

  async function toggleActive(s: StatusAdminRow, next: boolean) {
    if (s.is_system) return; // UI prevents this; defensive.
    const prev = statuses;
    setStatuses((rows) =>
      rows.map((x) => (x.id === s.id ? { ...x, is_active: next } : x)),
    );
    try {
      const res = await fetch(`/api/statuses/${s.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: s.name,
          description: s.description,
          color: s.color,
          is_active: next,
          notification_emails: (s.notification_emails ?? []).join(', '),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      toast.success(next ? 'הסטטוס הופעל' : 'הסטטוס הושבת');
    } catch (err) {
      setStatuses(prev);
      toast.error((err as Error).message);
    }
  }

  function openLinked(s: StatusAdminRow) {
    if (s.linked_count === 0) return;
    setLinkedFor(s);
  }

  function navigateToDebtor(apartment: string) {
    setLinkedFor(null);
    router.push(`/dashboard?apt=${encodeURIComponent(apartment)}&open=details`);
  }

  return (
    <div className="space-y-6">
      <Header onCreate={openCreate} />

      <Toolbar
        query={query}
        onQuery={setQuery}
        activeOnly={activeOnly}
        onActiveOnly={setActiveOnly}
      />

      {statuses.length === 0 ? (
        <EmptyState onCreate={openCreate} />
      ) : filtered.length === 0 ? (
        <NoResultsState />
      ) : (
        <StatusesTable
          rows={filtered}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          onToggleActive={toggleActive}
          onOpenLinked={openLinked}
        />
      )}

      <StatusFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={async () => {
          await refetch();
          setFormOpen(false);
        }}
      />

      <LinkedDebtorsSheet
        status={linkedFor}
        onOpenChange={(v) => { if (!v) setLinkedFor(null); }}
        onNavigate={navigateToDebtor}
      />

      <DeleteStatusDialog
        target={deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        onDeleted={async () => {
          await refetch();
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────

function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900">ניהול סטטוסים</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          הגדר ונהל את הסטטוסים המשמשים לסיווג חייבים.
        </p>
      </div>
      <Button
        type="button"
        onClick={onCreate}
        className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
      >
        <Plus className="h-4 w-4" />
        צור סטטוס חדש
      </Button>
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────────────────

function Toolbar({
  query, onQuery, activeOnly, onActiveOnly,
}: {
  query: string;
  onQuery: (v: string) => void;
  activeOnly: boolean;
  onActiveOnly: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 md:flex-row md:items-center md:justify-between">
      <div className="relative w-full md:max-w-xs">
        <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="חיפוש..."
          className="h-10 pe-9"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700 select-none cursor-pointer">
        <Switch
          checked={activeOnly}
          onCheckedChange={(v) => onActiveOnly(v)}
        />
        פעילים בלבד
      </label>
    </div>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────

function StatusesTable({
  rows, onEdit, onDelete, onToggleActive, onOpenLinked,
}: {
  rows: StatusAdminRow[];
  onEdit: (s: StatusAdminRow) => void;
  onDelete: (s: StatusAdminRow) => void;
  onToggleActive: (s: StatusAdminRow, next: boolean) => void;
  onOpenLinked: (s: StatusAdminRow) => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">שם סטטוס</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">תיאור</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">תצוגה</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">מקושרים</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">פעיל</TableHead>
            <TableHead className="h-11 px-4 text-left text-sm font-semibold text-slate-500">פעולות</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow
              key={s.id}
              className={cn(
                'border-b border-slate-100 hover:bg-slate-50 h-12',
                !s.is_active && 'opacity-60',
              )}
            >
              <TableCell className="px-4 py-3 text-right">
                <div className="inline-flex items-center gap-2">
                  <span className="font-bold text-slate-900">{s.name}</span>
                  {s.is_system && (
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Lock className="h-3 w-3 text-slate-400" />
                      </TooltipTrigger>
                      <TooltipContent>סטטוס מערכת — לא ניתן למחיקה</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-sm text-slate-600 max-w-xs truncate">
                {s.description ?? <span className="text-slate-400">—</span>}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                <span
                  className="inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold text-slate-900"
                  style={{ backgroundColor: s.color }}
                >
                  {s.name}
                </span>
              </TableCell>
              <TableCell className="px-4 py-3 text-center">
                <LinkedCount status={s} onOpen={onOpenLinked} />
              </TableCell>
              <TableCell className="px-4 py-3 text-center">
                <ActiveSwitch status={s} onToggle={onToggleActive} />
              </TableCell>
              <TableCell className="px-4 py-3 text-left">
                <RowActions
                  status={s}
                  onEdit={() => onEdit(s)}
                  onDelete={() => onDelete(s)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LinkedCount({
  status, onOpen,
}: { status: StatusAdminRow; onOpen: (s: StatusAdminRow) => void }) {
  if (status.linked_count === 0) {
    return <span className="text-sm font-bold text-slate-400 tabular-nums">0</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(status)}
      className="text-sm font-bold text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 tabular-nums"
    >
      {status.linked_count}
    </button>
  );
}

function ActiveSwitch({
  status, onToggle,
}: { status: StatusAdminRow; onToggle: (s: StatusAdminRow, next: boolean) => void }) {
  if (status.is_system) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Switch checked disabled />
        </TooltipTrigger>
        <TooltipContent>סטטוס מערכת — תמיד פעיל</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Switch
      checked={status.is_active}
      onCheckedChange={(v) => onToggle(status, v)}
      aria-label={status.is_active ? 'השבת סטטוס' : 'הפעל סטטוס'}
    />
  );
}

function RowActions({
  status, onEdit, onDelete,
}: {
  status: StatusAdminRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div dir="ltr" className="flex items-center justify-start gap-1">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label="עריכה"
          >
            <Pencil className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>עריכה</TooltipContent>
      </Tooltip>

      {status.is_system ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled
              aria-label="לא ניתן למחוק"
              className="text-slate-300"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>לא ניתן למחוק את סטטוס המערכת</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onDelete}
              aria-label="מחיקה"
              className="text-red-500 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>מחיקה</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// ─── Empty / No-results ─────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-blue-50 text-blue-600">
        <Sliders className="h-6 w-6" />
      </span>
      <h3 className="text-base font-semibold text-slate-900">
        טרם הוגדרו סטטוסים במערכת
      </h3>
      <p className="text-sm text-muted-foreground">צור סטטוס ראשון כדי להתחיל.</p>
      <Button
        type="button"
        onClick={onCreate}
        className="mt-2 gap-2 bg-blue-600 text-white hover:bg-blue-700"
      >
        <Plus className="h-4 w-4" />
        צור סטטוס חדש
      </Button>
    </div>
  );
}

function NoResultsState() {
  return (
    <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
      לא נמצאו סטטוסים התואמים לחיפוש.
    </div>
  );
}
