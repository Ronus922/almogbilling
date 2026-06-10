'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { UsersToolbar } from './UsersToolbar';
import { UsersTabs, type UsersTabKey, type UsersTabCounts } from './UsersTabs';
import { UserCard } from './UserCard';
import { InviteCard } from './InviteCard';
import { InviteUserPanel } from './InviteUserPanel';
import { UserSidePanel } from './UserSidePanel';
import type { UserListRow, InviteListRow } from '@/lib/db/users';

interface Props {
  initialUsers: UserListRow[];
  initialInvites: InviteListRow[];
  currentUserId: string;
}

function matchesSearch(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

export function UsersClient({ initialUsers, initialInvites, currentUserId }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [tab, setTab] = useState<UsersTabKey>('all');
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  // Tab counters — based on raw data, not the filtered view.
  const counts: UsersTabCounts = useMemo(() => ({
    all:         initialUsers.length,
    super_admin: initialUsers.filter((u) => u.role === 'super_admin').length,
    admin:       initialUsers.filter((u) => u.role === 'admin').length,
    manager:     initialUsers.filter((u) => u.role === 'manager').length,
    viewer:      initialUsers.filter((u) => u.role === 'viewer').length,
    invites:     initialInvites.length,
  }), [initialUsers, initialInvites]);

  // Filter data by tab + search.
  const visibleUsers = useMemo(() => {
    if (tab === 'invites') return [];
    const q = search.trim().toLowerCase();
    return initialUsers.filter((u) => {
      if (tab !== 'all' && u.role !== tab) return false;
      if (!q) return true;
      const name = (u.full_name ?? '').toLowerCase();
      return matchesSearch(name, q) || matchesSearch(u.email, q);
    });
  }, [initialUsers, tab, search]);

  const visibleInvites = useMemo(() => {
    if (tab !== 'invites') return [];
    const q = search.trim().toLowerCase();
    return initialInvites.filter((inv) => {
      if (!q) return true;
      return matchesSearch(inv.full_name, q) || matchesSearch(inv.email, q);
    });
  }, [initialInvites, tab, search]);

  async function onResendInvite(id: string) {
    try {
      const r = await fetch(`/api/invites/${id}/resend`, { method: 'POST' });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'שליחה נכשלה');
      }
      toast.success('ההזמנה נשלחה שוב');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function onCancelInvite(id: string) {
    try {
      const r = await fetch(`/api/invites/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'ביטול נכשל');
      }
      toast.success('ההזמנה בוטלה');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const showingInvites = tab === 'invites';
  const isEmpty = showingInvites ? visibleInvites.length === 0 : visibleUsers.length === 0;

  return (
    <>
      <UsersToolbar
        totalCount={initialUsers.length}
        search={search}
        onSearchChange={setSearch}
        onCreate={() => setInviteOpen(true)}
      >
        <UsersTabs active={tab} counts={counts} onChange={setTab} />
      </UsersToolbar>

      {/* Cards list */}
      {isEmpty ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          {showingInvites ? (
            'אין הזמנות פתוחות.'
          ) : (
            <>
              אין משתמשים להצגה.{' '}
              <span className="text-slate-700">לחץ על &quot;צור משתמש&quot;.</span>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {showingInvites
            ? visibleInvites.map((inv) => (
                <InviteCard
                  key={inv.id}
                  invite={inv}
                  onResend={onResendInvite}
                  onCancel={onCancelInvite}
                />
              ))
            : visibleUsers.map((u) => (
                <UserCard
                  key={u.id}
                  user={u}
                  isSelf={u.id === currentUserId}
                  onSelect={(id) => setActiveUserId(id)}
                />
              ))}
        </div>
      )}

      <InviteUserPanel
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />

      <UserSidePanel
        open={!!activeUserId}
        userId={activeUserId}
        currentUserId={currentUserId}
        onOpenChange={(o) => { if (!o) setActiveUserId(null); }}
      />
    </>
  );
}
