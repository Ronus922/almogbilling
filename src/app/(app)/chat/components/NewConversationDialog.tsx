'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { User, Users, Search, Loader2, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { initials } from './format';

interface PickUser {
  id: string;
  name: string;
}

type Mode = 'direct' | 'group';

export function NewConversationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called with the new (or existing) conversation id after creation. */
  onCreated: (conversationId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('direct');
  const [users, setUsers] = useState<PickUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [search, setSearch] = useState('');
  const [resultsOpen, setResultsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMode('direct');
    setSearch('');
    setResultsOpen(false);
    setSelected(new Set());
    setGroupName('');
    setLoadingUsers(true);
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/chat/users', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const data = (await r.json()) as { users: PickUser[] };
        if (!cancelled) setUsers(data.users);
      } catch {
        if (!cancelled) toast.error('טעינת המשתמשים נכשלה');
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Switching mode resets the in-progress picker so stale selections / search
  // don't carry over between direct and group.
  useEffect(() => {
    setSearch('');
    setResultsOpen(false);
    setSelected(new Set());
  }, [mode]);

  // Click outside the picker closes the results dropdown.
  useEffect(() => {
    if (!resultsOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setResultsOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [resultsOpen]);

  const term = search.trim().toLowerCase();
  // Results never include the already-selected members (group): once picked, a
  // user leaves the list. Direct mode keeps a single selection so there's
  // nothing to exclude.
  const filtered = useMemo(() => {
    const base = mode === 'group' ? users.filter((u) => !selected.has(u.id)) : users;
    return term ? base.filter((u) => u.name.toLowerCase().includes(term)) : base;
  }, [users, selected, mode, term]);

  const selectedUsers = useMemo(
    () => users.filter((u) => selected.has(u.id)),
    [users, selected],
  );

  async function createConversation(payload: Record<string, unknown>) {
    setSubmitting(true);
    try {
      const r = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !data.id) throw new Error(data.error || 'יצירת השיחה נכשלה');
      onCreated(data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'יצירת השיחה נכשלה');
    } finally {
      setSubmitting(false);
    }
  }

  // Direct: pick one user → close the dropdown, clear search, create immediately.
  function pickDirect(userId: string) {
    if (submitting) return;
    setResultsOpen(false);
    setSearch('');
    void createConversation({ type: 'direct', user_id: userId });
  }

  // Group: add a member → remove from results, clear search so the list
  // collapses. Creation happens only via the explicit "צור קבוצה" button.
  function addMember(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
    setSearch('');
    setResultsOpen(false);
  }

  function removeMember(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }

  function createGroup() {
    if (submitting) return;
    const name = groupName.trim();
    if (!name) {
      toast.error('יש להזין שם לקבוצה');
      return;
    }
    if (selected.size === 0) {
      toast.error('יש לבחור לפחות משתתף אחד');
      return;
    }
    void createConversation({ type: 'group', name, member_ids: Array.from(selected) });
  }

  const showResults = resultsOpen && !loadingUsers;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>שיחה חדשה</DialogTitle>
        </DialogHeader>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <ModeButton active={mode === 'direct'} onClick={() => setMode('direct')} icon={User}>
            שיחה אישית
          </ModeButton>
          <ModeButton active={mode === 'group'} onClick={() => setMode('group')} icon={Users}>
            קבוצה
          </ModeButton>
        </div>

        {mode === 'group' && (
          <div className="space-y-1.5">
            <Label htmlFor="group-name" className="text-sm font-medium text-muted-foreground">
              שם הקבוצה
            </Label>
            <Input
              id="group-name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="לדוגמה: צוות גבייה"
              maxLength={80}
              className="h-10"
            />
          </div>
        )}

        {/* Selected members (group) — removable chips */}
        {mode === 'group' && selectedUsers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedUsers.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-brand-soft py-0.5 pe-2 ps-1 text-xs font-semibold text-brand-text"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/70 text-[10px] font-bold text-brand-text">
                  {initials(u.name)}
                </span>
                <span className="max-w-[10rem] truncate">{u.name}</span>
                <button
                  type="button"
                  onClick={() => removeMember(u.id)}
                  disabled={submitting}
                  aria-label={`הסר את ${u.name}`}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-brand-text transition-colors hover:bg-white/60 disabled:opacity-60"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* User search + results dropdown */}
        <div ref={pickerRef} className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setResultsOpen(true); }}
            onFocus={() => setResultsOpen(true)}
            placeholder={mode === 'group' ? 'הוספת משתתף' : 'חיפוש משתמש'}
            className="h-10 pe-9"
            autoFocus
          />

          {showResults && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">
                  {users.length === 0
                    ? 'אין משתמשים זמינים'
                    : mode === 'group' && selectedUsers.length > 0 && !term
                      ? 'כל המשתמשים נבחרו'
                      : 'לא נמצאו משתמשים'}
                </p>
              ) : (
                filtered.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => (mode === 'direct' ? pickDirect(u.id) : addMember(u.id))}
                    className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5 text-start transition-colors hover:bg-slate-50 disabled:opacity-60"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand-text">
                      {initials(u.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                      {u.name}
                    </span>
                    {mode === 'group' && <Check className="h-4 w-4 shrink-0 text-slate-300" />}
                  </button>
                ))
              )}
            </div>
          )}

          {loadingUsers && (
            <div className="absolute inset-x-0 top-full z-20 mt-1 flex items-center justify-center rounded-lg border border-slate-200 bg-white py-6 text-slate-400 shadow-lg">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
        </div>

        {mode === 'group' && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              ביטול
            </Button>
            <Button
              onClick={createGroup}
              disabled={submitting || selected.size === 0 || !groupName.trim()}
              className="gap-2 bg-brand text-white hover:bg-brand-dark"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              צור קבוצה
              {selected.size > 0 && ` (${selected.size})`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active, onClick, icon: Icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof User;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
        active
          ? 'border-brand-border bg-brand-soft text-brand-text'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      <Icon className="h-4 w-4" /> {children}
    </button>
  );
}
