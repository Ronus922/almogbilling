'use client';

import { useEffect, useState } from 'react';
import { User, Users, Search, Loader2, Check } from 'lucide-react';
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('direct');
    setSearch('');
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

  const term = search.trim().toLowerCase();
  const filtered = term ? users.filter((u) => u.name.toLowerCase().includes(term)) : users;

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

  function startDirect(userId: string) {
    if (submitting) return;
    void createConversation({ type: 'direct', user_id: userId });
  }

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
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

        {/* User search */}
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש משתמש"
            className="h-10 pe-9"
            autoFocus
          />
        </div>

        {/* User list */}
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {loadingUsers ? (
            <div className="flex items-center justify-center py-6 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">
              {users.length === 0 ? 'אין משתמשים זמינים' : 'לא נמצאו משתמשים'}
            </p>
          ) : (
            filtered.map((u) => {
              const isSelected = selected.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => (mode === 'direct' ? startDirect(u.id) : toggle(u.id))}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border p-2.5 text-start transition-colors disabled:opacity-60',
                    mode === 'group' && isSelected
                      ? 'border-brand-border bg-brand-soft'
                      : 'border-slate-200 bg-white hover:bg-slate-50',
                  )}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand-text">
                    {initials(u.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                    {u.name}
                  </span>
                  {mode === 'group' && (
                    <span
                      className={cn(
                        'grid h-5 w-5 shrink-0 place-items-center rounded-md border',
                        isSelected ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white',
                      )}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5" />}
                    </span>
                  )}
                </button>
              );
            })
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
