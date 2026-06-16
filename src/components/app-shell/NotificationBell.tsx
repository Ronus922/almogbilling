'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, Eraser, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  getNotificationVisual, formatRelativeTime, SOURCE_MODULE_LABEL,
} from '@/lib/notifications/registry';
import type { Notification } from '@/lib/types/tasks';

const POLL_MS = 60_000;

type TabValue = 'all' | 'unread' | 'tasks' | 'issues' | 'calendar' | 'whatsapp' | 'internal_chat';

const TABS: { value: TabValue; label: string }[] = [
  { value: 'all', label: 'הכל' },
  { value: 'unread', label: 'לא נקראו' },
  { value: 'tasks', label: SOURCE_MODULE_LABEL.tasks },
  { value: 'issues', label: SOURCE_MODULE_LABEL.issues },
  { value: 'calendar', label: SOURCE_MODULE_LABEL.calendar },
  { value: 'whatsapp', label: SOURCE_MODULE_LABEL.whatsapp },
  { value: 'internal_chat', label: SOURCE_MODULE_LABEL.internal_chat },
];

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabValue>('all');
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  // Lightweight 60s poll — active unread count only (badge + "לא נקראו" tab badge).
  const fetchCount = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/unread-count', { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as { count?: number };
      setUnread(typeof data.count === 'number' ? data.count : 0);
    } catch {
      /* polling — ignore transient errors */
    }
  }, []);

  // The active list for the current tab — fetched on demand (open / tab change).
  const fetchList = useCallback(async (t: TabValue) => {
    try {
      const r = await fetch(`/api/notifications?tab=${t}&limit=10`, { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as { items?: Notification[]; unreadCount?: number };
      setItems(Array.isArray(data.items) ? data.items : []);
      if (typeof data.unreadCount === 'number') setUnread(data.unreadCount);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchCount();
    const t = setInterval(() => { void fetchCount(); }, POLL_MS);
    return () => clearInterval(t);
  }, [fetchCount]);

  // (Re)load the list when the panel opens or the tab changes.
  useEffect(() => {
    if (open) void fetchList(tab);
  }, [open, tab, fetchList]);

  function markReadLocal(id: string) {
    setItems((prev) =>
      tab === 'unread'
        ? prev.filter((n) => n.id !== id) // leaves the "unread" tab immediately
        : prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
  }

  async function markRead(id: string) {
    markReadLocal(id);
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  async function markAllRead() {
    setItems((prev) => (tab === 'unread' ? [] : prev.map((n) => ({ ...n, is_read: true }))));
    setUnread(0);
    try {
      await fetch('/api/notifications/read-all', { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  async function clearAll() {
    // Soft-clear removes items from EVERY tab (including "הכל").
    setItems([]);
    setUnread(0);
    try {
      await fetch('/api/notifications/clear-all', { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  // Soft-clear ONE notification — removes it from the list immediately (optimistic)
  // and reconciles the unread badge from the server response.
  async function clearOne(id: string) {
    const wasUnread = items.some((n) => n.id === id && !n.is_read);
    setItems((prev) => prev.filter((n) => n.id !== id));
    if (wasUnread) setUnread((u) => Math.max(0, u - 1));
    try {
      const r = await fetch(`/api/notifications/${id}/clear`, { method: 'PATCH', credentials: 'include' });
      if (r.ok) {
        const d = (await r.json()) as { unreadCount?: number };
        if (typeof d.unreadCount === 'number') setUnread(d.unreadCount);
      }
    } catch { /* ignore */ }
  }

  function onItemClick(n: Notification) {
    // Clicking always marks read (the row dims in place). Navigate + close only
    // when there's somewhere to go — otherwise stay open so the read state shows.
    if (!n.is_read) void markRead(n.id);
    if (n.action_url) {
      setOpen(false);
      router.push(n.action_url);
    }
  }

  const badge = unread > 9 ? '+9' : String(unread);
  const hasActive = items.length > 0 || unread > 0;
  const emptyMsg = tab === 'unread' ? 'אין התראות חדשות' : 'אין התראות';

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
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="end" className="w-[380px] p-0">
        {/* Header: title (start) + two textual actions (end) */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">התראות</h3>
          <div className="flex items-center gap-3">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-700 cursor-pointer"
              >
                <CheckCheck className="h-3.5 w-3.5" /> סמן הכל כנקרא
              </button>
            )}
            {hasActive && (
              <button
                type="button"
                onClick={() => void clearAll()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-700 cursor-pointer"
              >
                <Eraser className="h-3.5 w-3.5" /> נקה הכל
              </button>
            )}
          </div>
        </div>

        {/* Tabs strip — wraps to 2 rows so all 7 tabs stay visible (no clipping) */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-2 py-2">
          {TABS.map((t) => {
            const active = tab === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-xs whitespace-nowrap transition-colors cursor-pointer',
                  active ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500 hover:bg-slate-50',
                )}
              >
                {t.label}
                {t.value === 'unread' && unread > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-100 px-1 text-[10px] font-bold text-blue-700">
                    {unread > 9 ? '+9' : unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* List */}
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">{emptyMsg}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((n) => {
                const v = getNotificationVisual(n.type);
                const Icon = v.icon;
                return (
                  <li
                    key={n.id}
                    className={cn('group flex items-stretch transition-colors hover:bg-slate-50', !n.is_read && 'bg-blue-50/40')}
                  >
                    <button
                      type="button"
                      onClick={() => onItemClick(n)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 text-start cursor-pointer"
                    >
                      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', v.toneClass, n.is_read && 'opacity-60')}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-sm font-semibold', n.is_read ? 'text-slate-500' : 'text-slate-900')}>
                          {n.title}
                        </span>
                        {n.message && (
                          <span className={cn('block truncate text-xs', n.is_read ? 'text-slate-400' : 'text-slate-500')}>
                            {n.message}
                          </span>
                        )}
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {formatRelativeTime(n.created_at)}
                        </span>
                      </span>
                      {!n.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
                    </button>
                    <button
                      type="button"
                      aria-label="מחק התראה"
                      title="מחק התראה"
                      onClick={() => void clearOne(n.id)}
                      className="grid w-11 shrink-0 place-items-center text-slate-300 transition-colors hover:text-rose-600 focus-visible:text-rose-600 cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 px-4 py-2.5">
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/notifications'); }}
            className="w-full rounded-md py-1.5 text-center text-xs font-semibold text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 cursor-pointer"
          >
            צפה בכל ההתראות
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
