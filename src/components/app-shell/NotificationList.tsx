'use client';

import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNotificationVisual, formatRelativeTime } from '@/lib/notifications/registry';
import type { Notification } from '@/lib/types/tasks';

// Shared scrollable notification list for the header dropdowns (the bell and the
// dedicated WhatsApp chat dropdown). Items are always client-fetched on open, so
// the Date.now()-relative formatRelativeTime is never rendered during SSR → no
// hydration mismatch (#418) here, unlike the server-rendered /notifications page.
export function NotificationList({
  items,
  emptyMsg,
  onItemClick,
  onClear,
}: {
  items: Notification[];
  emptyMsg: string;
  onItemClick: (n: Notification) => void;
  onClear: (id: string) => void;
}) {
  return (
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
                  onClick={() => onClear(n.id)}
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
  );
}
