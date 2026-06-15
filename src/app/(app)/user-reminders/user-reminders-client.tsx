'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus, Bell, BellOff, User, Share2, Clock, CircleCheckBig, Tag, Pencil, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { UserReminderWithNames } from '@/lib/types/userReminders';
import type { ReminderCategoryWithCount } from '@/lib/types/reminderCategories';
import { ReminderCard } from '@/components/user-reminders/ReminderCard';
import { ReminderFormPanel } from '@/components/user-reminders/ReminderFormPanel';
import { CategoryFormPanel } from '@/components/user-reminders/CategoryFormPanel';
import { reminderErrorMessage } from '@/components/user-reminders/helpers';

interface Assignee {
  id: string;
  name: string;
}

type TabKey = 'mine' | 'shared' | 'open' | 'done';

const TABS: { key: TabKey; label: string; icon: typeof User }[] = [
  { key: 'mine', label: 'שלי', icon: User },
  { key: 'shared', label: 'משותף איתי', icon: Share2 },
  { key: 'open', label: 'פתוחים', icon: Clock },
  { key: 'done', label: 'הושלמו', icon: CircleCheckBig },
];

interface DeleteTarget {
  kind: 'reminder' | 'category';
  id: string;
  name: string;
}

export function UserRemindersClient({
  canEdit,
  currentUserId,
  assignees,
}: {
  canEdit: boolean;
  currentUserId: string;
  assignees: Assignee[];
}) {
  const [reminders, setReminders] = useState<UserReminderWithNames[]>([]);
  const [categories, setCategories] = useState<ReminderCategoryWithCount[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<TabKey>('mine');
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);

  const [reminderPanelOpen, setReminderPanelOpen] = useState(false);
  const [editingReminder, setEditingReminder] = useState<UserReminderWithNames | null>(null);
  const [categoryPanelOpen, setCategoryPanelOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ReminderCategoryWithCount | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`/api/user-reminders?involvingUser=${encodeURIComponent(currentUserId)}`, { credentials: 'include' }),
        fetch('/api/reminder-categories', { credentials: 'include' }),
      ]);
      if (!rRes.ok) throw new Error(`HTTP ${rRes.status}`);
      if (!cRes.ok) throw new Error(`HTTP ${cRes.status}`);
      const rData = (await rRes.json()) as { items?: UserReminderWithNames[] };
      const cData = (await cRes.json()) as { items?: ReminderCategoryWithCount[] };
      setReminders(Array.isArray(rData.items) ? rData.items : []);
      setCategories(Array.isArray(cData.items) ? cData.items : []);
    } catch (err) {
      toast.error(`טעינת התזכורות נכשלה: ${(err as Error).message}`);
      setReminders([]);
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const now = Date.now();
  const isOverdue = (r: UserReminderWithNames) =>
    r.status === 'pending' && new Date(r.remind_at).getTime() < now;

  const tabPredicate = useCallback(
    (key: TabKey) => (r: UserReminderWithNames) => {
      switch (key) {
        case 'mine': return r.created_by === currentUserId;
        case 'shared': return r.assigned_to === currentUserId && r.created_by !== currentUserId;
        case 'open': return r.status === 'pending';
        case 'done': return r.status === 'done';
      }
    },
    [currentUserId],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = { mine: 0, shared: 0, open: 0, done: 0 };
    for (const t of TABS) counts[t.key] = reminders.filter(tabPredicate(t.key)).length;
    return counts;
  }, [reminders, tabPredicate]);

  const displayed = useMemo(() => {
    const base = reminders.filter(tabPredicate(tab));
    return activeCategoryId ? base.filter((r) => r.category_id === activeCategoryId) : base;
  }, [reminders, tab, tabPredicate, activeCategoryId]);

  const activeCategory = activeCategoryId
    ? categories.find((c) => c.id === activeCategoryId) ?? null
    : null;

  // ── Actions ──────────────────────────────────────────────────────────────────
  function openCreateReminder() {
    setEditingReminder(null);
    setReminderPanelOpen(true);
  }
  function openEditReminder(r: UserReminderWithNames) {
    setEditingReminder(r);
    setReminderPanelOpen(true);
  }
  function openCreateCategory() {
    setEditingCategory(null);
    setCategoryPanelOpen(true);
  }
  function openEditCategory(c: ReminderCategoryWithCount) {
    setEditingCategory(c);
    setCategoryPanelOpen(true);
  }

  // Quick "mark as done" from the card hover-action — PATCH status only.
  async function markDone(r: UserReminderWithNames) {
    try {
      const res = await fetch(`/api/user-reminders/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'done' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(reminderErrorMessage(data.error));
      }
      toast.success('התזכורת סומנה כהושלמה');
      await fetchData();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const url =
        deleteTarget.kind === 'reminder'
          ? `/api/user-reminders/${deleteTarget.id}`
          : `/api/reminder-categories/${deleteTarget.id}`;
      const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(reminderErrorMessage(data.error));
      }
      // If the deleted category was the active filter, clear it.
      if (deleteTarget.kind === 'category' && activeCategoryId === deleteTarget.id) {
        setActiveCategoryId(null);
      }
      toast.success(deleteTarget.kind === 'reminder' ? 'התזכורת נמחקה' : 'הקטגוריה נמחקה');
      setDeleteTarget(null);
      await fetchData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">תזכורות</h1>
          <span className="text-sm text-muted-foreground">תזכורות אישיות ומשותפות</span>
        </div>
        {canEdit && (
          <Button onClick={openCreateReminder} className="gap-2 bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> תזכורת חדשה
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
                active
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
              )}
            >
              <t.icon className="h-4 w-4" />
              <span className="truncate">{t.label}</span>
              <span
                className={cn(
                  'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 font-num text-xs font-bold tabular-nums',
                  active ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700',
                )}
              >
                {tabCounts[t.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Two-column. DOM order is [categories, reminders]. On desktop (RTL)
          flex-row puts the first child (categories) at the inline-start = RIGHT,
          reminders fill the left. On mobile flex-col-reverse flips the stack so
          the reminders list sits on TOP and categories below it. */}
      <div className="flex flex-col-reverse gap-6 lg:flex-row">
        {/* Categories column */}
        <aside className="lg:w-72 lg:shrink-0">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <Tag className="h-4 w-4 text-slate-400" /> קטגוריות
              </h2>
              {canEdit && (
                <button
                  type="button"
                  onClick={openCreateCategory}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200"
                >
                  <Plus className="h-3.5 w-3.5" /> חדשה
                </button>
              )}
            </div>

            <div className="mt-3 space-y-1">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/60" />
                ))
              ) : categories.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-400">
                  אין קטגוריות עדיין.
                  {canEdit && ' צור קטגוריה כדי לארגן תזכורות.'}
                </p>
              ) : (
                categories.map((c) => {
                  const active = activeCategoryId === c.id;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
                        active ? 'bg-blue-50' : 'hover:bg-slate-50',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveCategoryId((prev) => (prev === c.id ? null : c.id))}
                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded-full ring-1 ring-slate-200"
                          style={{ backgroundColor: c.color }}
                        />
                        <span className={cn('truncate text-sm', active ? 'font-semibold text-blue-700' : 'text-slate-700')}>
                          {c.name}
                        </span>
                        <span className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 font-num text-[11px] font-bold tabular-nums text-slate-500">
                          {c.open_count}
                        </span>
                      </button>
                      {canEdit && (
                        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => openEditCategory(c)}
                            aria-label="עריכת קטגוריה"
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget({ kind: 'category', id: c.id, name: c.name })}
                            aria-label="מחיקת קטגוריה"
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* Reminders main area */}
        <main className="min-w-0 flex-1">
          <div className="rounded-lg border bg-card p-4">
            {/* Center header */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">כל התזכורות</h2>
                <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 font-num text-xs font-bold tabular-nums text-slate-600">
                  {displayed.length}
                </span>
                {activeCategory && (
                  <button
                    type="button"
                    onClick={() => setActiveCategoryId(null)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: activeCategory.color }} />
                    {activeCategory.name}
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* List */}
            <div className="mt-4 space-y-2">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />
                ))
              ) : displayed.length === 0 ? (
                <EmptyReminders canEdit={canEdit} filtered={!!activeCategory} onCreate={openCreateReminder} />
              ) : (
                displayed.map((r) => (
                  <ReminderCard
                    key={r.id}
                    reminder={r}
                    canEdit={canEdit}
                    overdue={isOverdue(r)}
                    onOpen={() => openEditReminder(r)}
                    onComplete={() => void markDone(r)}
                    onDelete={() => setDeleteTarget({ kind: 'reminder', id: r.id, name: r.title })}
                  />
                ))
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Panels */}
      <ReminderFormPanel
        open={reminderPanelOpen}
        reminder={editingReminder}
        canEdit={canEdit}
        assignees={assignees}
        categories={categories}
        defaultCategoryId={activeCategoryId}
        onOpenChange={setReminderPanelOpen}
        onSaved={fetchData}
      />
      {canEdit && (
        <CategoryFormPanel
          open={categoryPanelOpen}
          category={editingCategory}
          onOpenChange={setCategoryPanelOpen}
          onSaved={fetchData}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === 'category' ? 'מחיקת קטגוריה?' : 'מחיקת תזכורת?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'category' ? (
                <>
                  הקטגוריה <span className="font-semibold">{deleteTarget?.name}</span> תועבר לארכיון.
                  תזכורות שמשויכות אליה יישארו ללא קטגוריה.
                </>
              ) : (
                <>
                  התזכורת <span className="font-semibold">{deleteTarget?.name}</span> תימחק (העברה לארכיון).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'מוחק…' : 'מחק'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyReminders({
  canEdit, filtered, onCreate,
}: { canEdit: boolean; filtered: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400">
        {filtered ? <BellOff className="h-6 w-6" /> : <Bell className="h-6 w-6" />}
      </span>
      <p className="text-sm text-muted-foreground">
        {filtered
          ? 'אין תזכורות בקטגוריה הזו בלשונית הנוכחית.'
          : canEdit
            ? 'אין כאן תזכורות עדיין. צור תזכורת חדשה כדי להתחיל.'
            : 'אין כאן תזכורות עדיין.'}
      </p>
      {canEdit && !filtered && (
        <Button onClick={onCreate} className="mt-1 gap-2 bg-blue-600 text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> תזכורת חדשה
        </Button>
      )}
    </div>
  );
}
