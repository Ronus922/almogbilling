'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, CheckCheck, Eraser } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NotificationList } from './NotificationList';
import type { Notification } from '@/lib/types/tasks';

const POLL_MS = 60_000;

// Dedicated WhatsApp chat dropdown — the twin of NotificationBell, filtered to
// source_module='whatsapp' only. The bell shows everything EXCEPT WhatsApp, so a
// WhatsApp notification is counted/shown here and ONLY here (the API partitions
// the two surfaces by source_module). Green accent matches the /messages screen
// (a declared DESIGN.md exception), not the blue bell.
export function WhatsappBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  // Lightweight 60s poll — reads the WhatsApp slice of the shared count endpoint.
  const fetchCount = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/unread-count', { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as { whatsappCount?: number };
      setUnread(typeof data.whatsappCount === 'number' ? data.whatsappCount : 0);
    } catch {
      /* polling — ignore transient errors */
    }
  }, []);

  // The WhatsApp-only list — fetched on demand (open).
  const fetchList = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications?tab=whatsapp&limit=10', { credentials: 'include' });
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

  useEffect(() => {
    if (open) void fetchList();
  }, [open, fetchList]);

  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    try {
      // surface=whatsapp → only WhatsApp rows; the bell's badge is untouched.
      await fetch('/api/notifications/read-all?surface=whatsapp', { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  async function clearAll() {
    setItems([]);
    setUnread(0);
    try {
      await fetch('/api/notifications/clear-all?surface=whatsapp', { method: 'PATCH', credentials: 'include' });
    } catch { /* ignore */ }
  }

  async function clearOne(id: string) {
    const wasUnread = items.some((n) => n.id === id && !n.is_read);
    setItems((prev) => prev.filter((n) => n.id !== id));
    if (wasUnread) setUnread((u) => Math.max(0, u - 1));
    try {
      const r = await fetch(`/api/notifications/${id}/clear`, { method: 'PATCH', credentials: 'include' });
      if (r.ok) {
        const d = (await r.json()) as { whatsappUnreadCount?: number };
        if (typeof d.whatsappUnreadCount === 'number') setUnread(d.whatsappUnreadCount);
      }
    } catch { /* ignore */ }
  }

  function onItemClick(n: Notification) {
    if (!n.is_read) void markRead(n.id);
    // Every WhatsApp notification carries action_url '/messages'.
    if (n.action_url) {
      setOpen(false);
      router.push(n.action_url);
    }
  }

  const badge = unread > 9 ? '+9' : String(unread);
  const hasActive = items.length > 0 || unread > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="צ׳אט וואטסאפ"
            className="relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover cursor-pointer"
          />
        }
      >
        <MessageCircle className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 items-center justify-center rounded-full bg-green-500 px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="end" className="w-[380px] p-0">
        {/* Header: title (start) + two textual actions (end) */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">הודעות וואטסאפ</h3>
          <div className="flex items-center gap-3">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-green-600 transition-colors hover:text-green-700 cursor-pointer"
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

        {/* List (WhatsApp only — no tabs strip) */}
        <NotificationList
          items={items}
          emptyMsg="אין הודעות וואטסאפ"
          onItemClick={onItemClick}
          onClear={(id) => void clearOne(id)}
        />

        {/* Footer */}
        <div className="border-t border-slate-200 px-4 py-2.5">
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/messages'); }}
            className="w-full rounded-md py-1.5 text-center text-xs font-semibold text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 cursor-pointer"
          >
            פתח צ׳אט וואטסאפ
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
