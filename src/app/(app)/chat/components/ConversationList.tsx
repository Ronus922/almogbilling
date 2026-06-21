'use client';

import { Search, MessagesSquare } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ConversationSummary } from '@/lib/types/internalChat';
import { formatRelativeStamp } from './format';
import { ChatAvatar } from './ChatAvatar';

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  search,
  onSearch,
  loading,
  className,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (c: ConversationSummary) => void;
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  className?: string;
}) {
  const term = search.trim().toLowerCase();
  const filtered = term
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(term) ||
          c.participant_names.some((n) => n.toLowerCase().includes(term)),
      )
    : conversations;

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white',
        className,
      )}
    >
      {/* Search */}
      <div className="border-b border-slate-100 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="חיפוש שיחה לפי שם"
            className="h-10 pe-9"
          />
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && conversations.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/60" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <MessagesSquare className="h-8 w-8 text-slate-300" />
            <p className="text-sm text-muted-foreground">
              {term ? 'לא נמצאו שיחות' : 'אין שיחות עדיין'}
            </p>
            {!term && (
              <p className="text-xs text-slate-400">התחל שיחה חדשה כדי לדבר עם חברי הצוות</p>
            )}
          </div>
        ) : (
          <ul>
            {filtered.map((c) => {
              const isActive = c.id === selectedId;
              const preview = (c.last_message_content ?? '').trim();
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c)}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-slate-50 border-r-[3px] p-3 text-start transition-colors',
                      isActive ? 'border-r-brand bg-brand-soft/60' : 'border-r-transparent hover:bg-slate-50',
                    )}
                  >
                    <ChatAvatar title={c.title} isGroup={c.type === 'group'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('truncate text-sm text-slate-900', c.unread_count > 0 ? 'font-bold' : 'font-semibold')}>{c.title}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                          {formatRelativeStamp(c.last_message_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            'truncate text-xs',
                            c.unread_count > 0 ? 'font-medium text-slate-700' : 'text-slate-500',
                          )}
                        >
                          {preview || (c.type === 'group' ? `${c.participant_count} משתתפים` : '—')}
                        </span>
                        {c.unread_count > 0 && (
                          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white tabular-nums">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
