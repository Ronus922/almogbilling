'use client';

import { useState, useRef, type KeyboardEvent } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { Section } from './Section';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { TenantNote } from '@/types/tenant';

interface Props {
  notes: TenantNote[];
  isAdmin: boolean;
  onAddComment: (content: string) => Promise<void>;
}

function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]);
}

function Avatar({ name }: { name: string }) {
  const initials = getInitials(name);
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-xs font-bold">
      {initials}
    </div>
  );
}

export function CommentsSection({ notes, isAdmin, onAddComment }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !sending && isAdmin;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      await onAddComment(trimmed);
      setDraft('');
      taRef.current?.focus();
    } catch {
      // parent handles toast; keep draft so user doesn't lose text
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <Section title="הערות ותיעוד" icon={MessageSquare} iconTone="slate">
      <div className="space-y-3">
        {/* Input area (new comment) */}
        <div>
          <div className="relative">
            <Textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="הוסיפו הערה..."
              disabled={!isAdmin || sending}
              rows={3}
              className="resize-none pb-14"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="שלח הערה"
              className={cn(
                'absolute bottom-2 end-2 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition-colors',
                canSend
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed',
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-400 text-start">
            לחץ <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Ctrl+Enter</kbd> לשליחה מהירה
          </p>
        </div>

        {/* Existing comments — below the input */}
        <div className="pt-3 border-t border-slate-100">
          {notes.length > 0 ? (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3"
                >
                  <Avatar name={n.author_name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-900">
                        {n.author_name}
                      </span>
                      <span className="text-xs text-slate-400 tabular-nums" dir="ltr">
                        {formatCommentTime(n.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap break-words">
                      {n.content}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-400 py-2 text-center">אין הערות עדיין.</p>
          )}
        </div>
      </div>
    </Section>
  );
}
