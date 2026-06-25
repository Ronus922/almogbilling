'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessagesSquare, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConversationSummary, InternalMessage, ThreadPayload } from '@/lib/types/internalChat';
import { ConversationList } from './ConversationList';
import { ChatThread } from './ChatThread';
import { NewConversationDialog } from './NewConversationDialog';

// Polling cadence (architectural decision — polling, not SSE/WebSocket):
const LIST_POLL_MS = 20_000;   // conversation list + unread counts
const THREAD_POLL_MS = 4_000;  // open thread (delta via ?since=)

function lastTimestamp(messages: InternalMessage[]): string | null {
  return messages.length ? messages[messages.length - 1].created_at : null;
}

function mergeMessages(prev: InternalMessage[], incoming: InternalMessage[]): InternalMessage[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const added = incoming.filter((m) => !seen.has(m.id));
  if (added.length === 0) return prev;
  return [...prev, ...added];
}

export function ChatClient({
  currentUserId,
  initialConversationId,
}: {
  currentUserId: string;
  initialConversationId: string | null;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [header, setHeader] = useState<ThreadPayload['conversation'] | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  const messagesRef = useRef<InternalMessage[]>([]);
  const initialHandledRef = useRef(false);
  selectedIdRef.current = selected?.id ?? null;
  messagesRef.current = messages;

  const fetchConversations = useCallback(async (silent = false) => {
    if (!silent) setLoadingConvos(true);
    try {
      const r = await fetch('/api/chat/conversations', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { items: ConversationSummary[] };
      setConversations(data.items);
      return data.items;
    } catch {
      if (!silent) toast.error('טעינת השיחות נכשלה');
      return null;
    } finally {
      if (!silent) setLoadingConvos(false);
    }
  }, []);

  // Full thread load (on select). Resets the read cursor server-side.
  const loadThread = useCallback(async (conversationId: string) => {
    setLoadingThread(true);
    try {
      const r = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
        credentials: 'include',
      });
      if (r.status === 403) {
        toast.error('אין לך גישה לשיחה זו');
        setSelected(null);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ThreadPayload;
      if (selectedIdRef.current !== conversationId) return; // switched away
      setHeader(data.conversation);
      setMessages(data.messages);
      // Reading clears the local unread badge immediately.
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c)),
      );
    } catch {
      toast.error('טעינת השיחה נכשלה');
    } finally {
      setLoadingThread(false);
    }
  }, []);

  // Delta poll for the open thread (only newer messages via ?since=).
  const pollThread = useCallback(async (conversationId: string) => {
    const since = lastTimestamp(messagesRef.current);
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    try {
      const r = await fetch(`/api/chat/conversations/${conversationId}/messages${qs}`, {
        credentials: 'include',
      });
      if (!r.ok) return;
      const data = (await r.json()) as ThreadPayload;
      if (selectedIdRef.current !== conversationId) return;
      setHeader(data.conversation);
      if (data.messages.length > 0) {
        setMessages((prev) => mergeMessages(prev, data.messages));
      }
    } catch {
      /* transient — next tick retries */
    }
  }, []);

  const selectConversation = useCallback(
    (c: ConversationSummary) => {
      setSelected(c);
      setHeader(null);
      setMessages([]);
      messagesRef.current = [];
      void loadThread(c.id);
    },
    [loadThread],
  );

  // Initial conversation list + deep-link (?c=<id>) selection.
  useEffect(() => {
    void (async () => {
      const items = await fetchConversations();
      if (initialHandledRef.current) return;
      initialHandledRef.current = true;
      if (initialConversationId && items) {
        const match = items.find((c) => c.id === initialConversationId);
        if (match) selectConversation(match);
      } else if (items?.length && window.matchMedia('(min-width: 768px)').matches) {
        // Open the most-recent conversation on load (list is sorted last_message
        // desc). Desktop only — on mobile the list-first view is the better
        // landing (selecting would hide the list behind the thread). ponytail.
        selectConversation(items[0]);
      }
    })();
  }, [fetchConversations, initialConversationId, selectConversation]);

  // Poll the conversation list (unread counts) every 20s.
  useEffect(() => {
    const id = setInterval(() => void fetchConversations(true), LIST_POLL_MS);
    return () => clearInterval(id);
  }, [fetchConversations]);

  // Poll the open thread every 4s.
  useEffect(() => {
    if (!selected) return;
    const id = setInterval(() => {
      const cid = selectedIdRef.current;
      if (cid) void pollThread(cid);
    }, THREAD_POLL_MS);
    return () => clearInterval(id);
  }, [selected, pollThread]);

  const sendMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const cid = selectedIdRef.current;
      if (!cid) return false;
      try {
        const r = await fetch(`/api/chat/conversations/${cid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content }),
        });
        const data = (await r.json().catch(() => ({}))) as { message?: InternalMessage; error?: string };
        if (!r.ok || !data.message) throw new Error(data.error || 'שליחה נכשלה');
        if (selectedIdRef.current === cid) {
          setMessages((prev) => mergeMessages(prev, [data.message!]));
        }
        void fetchConversations(true);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
        return false;
      }
    },
    [fetchConversations],
  );

  const handleCreated = useCallback(
    async (conversationId: string) => {
      setNewOpen(false);
      const items = await fetchConversations(true);
      const match = items?.find((c) => c.id === conversationId);
      if (match) {
        selectConversation(match);
      } else {
        // List not yet reflecting it — select a minimal placeholder; loadThread
        // fills the header.
        setSelected({
          id: conversationId,
          type: 'direct',
          title: '',
          participant_names: [],
          participant_count: 0,
          last_message_content: null,
          last_message_at: null,
          unread_count: 0,
        });
        setHeader(null);
        setMessages([]);
        messagesRef.current = [];
        void loadThread(conversationId);
      }
    },
    [fetchConversations, selectConversation, loadThread],
  );

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <MessagesSquare className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">צ׳אט פנימי</h1>
            <p className="text-sm text-muted-foreground">תקשורת בין חברי הצוות</p>
          </div>
        </div>
        <Button
          type="button"
          onClick={() => setNewOpen(true)}
          className="gap-2 bg-brand text-white hover:bg-brand-dark"
        >
          <Plus className="h-4 w-4" /> שיחה חדשה
        </Button>
      </div>

      {/* Body — two panels (RTL: list on the right, thread on the left) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(300px,360px)_1fr]">
        <ConversationList
          conversations={conversations}
          selectedId={selected?.id ?? null}
          onSelect={selectConversation}
          search={search}
          onSearch={setSearch}
          loading={loadingConvos}
          className={cn(selected && 'hidden md:flex')}
        />
        <ChatThread
          conversation={selected}
          header={header}
          messages={messages}
          loading={loadingThread}
          currentUserId={currentUserId}
          onSend={sendMessage}
          onBack={() => setSelected(null)}
          className={cn(!selected && 'hidden md:flex')}
        />
      </div>

      <NewConversationDialog open={newOpen} onOpenChange={setNewOpen} onCreated={handleCreated} />
    </div>
  );
}
