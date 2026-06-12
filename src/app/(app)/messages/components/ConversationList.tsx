'use client';

import { Search, MessageCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Conversation } from '@/types/whatsapp';
import { conversationTitle, previewText, formatListStamp } from './format';
import { ChatAvatar } from './ChatAvatar';

export function ConversationList({
  conversations,
  selectedChatId,
  onSelect,
  search,
  onSearch,
  loading,
  className,
}: {
  conversations: Conversation[];
  selectedChatId: string | null;
  onSelect: (c: Conversation) => void;
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white',
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
            placeholder="חיפוש לפי שם, טלפון או דירה"
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
        ) : conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <MessageCircle className="h-8 w-8 text-slate-300" />
            <p className="text-sm text-muted-foreground">
              {search ? 'לא נמצאו שיחות' : 'אין שיחות עדיין'}
            </p>
          </div>
        ) : (
          <ul>
            {conversations.map((c) => {
              const title = conversationTitle(c);
              const isActive = c.chat_id === selectedChatId;
              const preview = previewText(c.last_content, c.last_type);
              return (
                <li key={c.chat_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c)}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-slate-50 p-3 text-start transition-colors',
                      isActive ? 'bg-emerald-50/70' : 'hover:bg-slate-50',
                    )}
                  >
                    <ChatAvatar title={title} isGroup={c.is_group} avatarUrl={c.avatar_url} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-slate-900">{title}</span>
                          {c.apartment_number && (
                            <span className="shrink-0 text-[11px] font-medium text-slate-400">
                              · דירה {c.apartment_number}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                          {formatListStamp(c.last_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className={cn('truncate text-xs', c.unread > 0 ? 'font-medium text-slate-700' : 'text-slate-500')}>
                          {c.last_direction === 'sent' && preview && <span className="text-slate-400">↩ </span>}
                          {preview || '—'}
                        </span>
                        {c.unread > 0 && (
                          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-[11px] font-bold text-white tabular-nums">
                            {c.unread}
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
