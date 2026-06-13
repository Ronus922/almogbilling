'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Notification } from '@/lib/types/tasks';

const POLL_MS = 60_000;

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-rose-500',
  high: 'bg-amber-500',
  normal: 'bg-blue-500',
  low: 'bg-slate-400',
};

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const fetchNotifications = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications?limit=20', { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as { items?: Notification[]; unreadCount?: number };
      setItems(Array.isArray(data.items) ? data.items : []);
      setUnread(typeof data.unreadCount === 'number' ? data.unreadCount : 0);
    } catch {
      /* polling — ignore transient errors */
    }
  }, []);

  // Initial fetch + 60s polling.
  useEffect(() => {
    void fetchNotifications();
    const t = setInterval(() => { void fetchNotifications(); }, POLL_MS);
    return () => clearInterval(t);
  }, [fetchNotifications]);

  // Refresh when the dropdown opens (so the list is fresh on demand).
  useEffect(() => {
    if (open) void fetchNotifications();
  }, [open, fetchNotifications]);

  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
    } catch { /* ignore */ }
  }

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ all: true }),
      });
    } catch { /* ignore */ }
  }

  function onItemClick(n: Notification) {
    if (!n.is_read) void markRead(n.id);
    setOpen(false);
    if (n.action_url) router.push(n.action_url);
  }

  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="התראות"
            className="relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover cursor-pointer"
          />
        }
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-[#e5484d] px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">התראות</h3>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-700 cursor-pointer"
            >
              <CheckCheck className="h-3.5 w-3.5" /> סמן הכל כנקרא
            </button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">אין התראות</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onItemClick(n)}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-4 py-3 text-start transition-colors hover:bg-slate-50 cursor-pointer',
                      !n.is_read && 'bg-blue-50/40',
                    )}
                  >
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : PRIORITY_DOT[n.priority] ?? 'bg-blue-500')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{n.title}</span>
                      {n.message && <span className="block truncate text-xs text-slate-500">{n.message}</span>}
                      <span dir="ltr" className="mt-0.5 block text-[11px] tabular-nums text-slate-400 text-start">
                        {new Date(n.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
