'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Conversation, ThreadMessage, InstanceOption } from '@/types/whatsapp';
import { ConversationList } from './ConversationList';
import { ChatThread } from './ChatThread';
import { NewConversationDialog } from './NewConversationDialog';
import { BroadcastPanel } from './BroadcastPanel';
import { TemplatesTab } from './TemplatesTab';

const POLL_MS = 5000;

type Tab = 'chats' | 'templates';

export function MessagesClient({
  canEdit,
  canManageTemplates,
  isAdmin,
  currentUserId,
}: {
  canEdit: boolean;
  canManageTemplates: boolean;
  isAdmin: boolean;
  currentUserId: string;
}) {
  const [tab, setTab] = useState<Tab>('chats');
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  // Multi-instance: admins can switch which employee's inbox they view. The
  // selected instance scopes the conversation list, threads, sending and reads.
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  // Keep the latest selected chat id + filters available to the polling closure.
  const selectedIdRef = useRef<string | null>(null);
  const searchRef = useRef('');
  const instanceRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.chat_id ?? null;
  searchRef.current = search;
  instanceRef.current = selectedInstanceId;

  /** `&instance_id=…` suffix for the currently selected instance (or ''). */
  const instParam = useCallback(
    () => (instanceRef.current ? `&instance_id=${encodeURIComponent(instanceRef.current)}` : ''),
    [],
  );

  const fetchConversations = useCallback(async (q: string, silent = false) => {
    if (!silent) setLoadingConvos(true);
    try {
      const r = await fetch(
        `/api/whatsapp/conversations?search=${encodeURIComponent(q)}${instParam()}`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as Conversation[];
      setConversations(data);
    } catch {
      if (!silent) toast.error('טעינת השיחות נכשלה');
    } finally {
      if (!silent) setLoadingConvos(false);
    }
  }, [instParam]);

  const fetchThread = useCallback(async (chatId: string, silent = false) => {
    if (!silent) setLoadingThread(true);
    try {
      const r = await fetch(
        `/api/whatsapp/thread?chat_id=${encodeURIComponent(chatId)}${instParam()}`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ThreadMessage[];
      // Ignore a late response for a conversation the user already left.
      if (selectedIdRef.current === chatId) setThread(data);
    } catch {
      if (!silent) toast.error('טעינת השיחה נכשלה');
    } finally {
      if (!silent) setLoadingThread(false);
    }
  }, [instParam]);

  // Load the instances this user may view; default to their own, else the first.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/whatsapp/instances', { credentials: 'include' });
        if (!r.ok) return;
        const data = (await r.json()) as InstanceOption[];
        if (cancelled) return;
        setInstances(data);
        const own = data.find((i) => i.user_id === currentUserId);
        setSelectedInstanceId(own?.id ?? data[0]?.id ?? null);
      } catch {
        /* selector is optional — inbox still works on the server default */
      }
    })();
    return () => { cancelled = true; };
  }, [currentUserId]);

  // Initial load + reload whenever the viewed instance changes (admin switch).
  // Clears the open conversation since chat ids are scoped per instance.
  useEffect(() => {
    setSelected(null);
    setThread([]);
    void fetchConversations(searchRef.current);
  }, [selectedInstanceId, fetchConversations]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => void fetchConversations(searchRef.current, true), 300);
    return () => clearTimeout(t);
  }, [search, fetchConversations]);

  // Polling — refresh the list and the open thread every few seconds.
  useEffect(() => {
    const id = setInterval(() => {
      void fetchConversations(searchRef.current, true);
      const cid = selectedIdRef.current;
      if (cid) void fetchThread(cid, true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchConversations, fetchThread]);

  const markRead = useCallback(async (chatId: string) => {
    try {
      const q = instanceRef.current ? `?instance_id=${encodeURIComponent(instanceRef.current)}` : '';
      await fetch(`/api/whatsapp/conversations/${encodeURIComponent(chatId)}/read${q}`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* non-fatal */
    }
  }, []);

  const selectConversation = useCallback(
    (c: Conversation) => {
      setSelected(c);
      setThread([]);
      void fetchThread(c.chat_id);
      // Optimistically clear the unread badge, then persist + refresh.
      setConversations((prev) =>
        prev.map((x) => (x.chat_id === c.chat_id ? { ...x, unread: 0 } : x)),
      );
      if (c.unread > 0) {
        void markRead(c.chat_id).then(() => fetchConversations(searchRef.current, true));
      }
    },
    [fetchThread, markRead, fetchConversations],
  );

  const handleSent = useCallback(() => {
    const cid = selectedIdRef.current;
    if (cid) void fetchThread(cid, true);
    void fetchConversations(searchRef.current, true);
  }, [fetchThread, fetchConversations]);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <MessageCircle className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">הודעות</h1>
            <p className="text-sm text-muted-foreground">צ׳אט וואטסאפ — שיחות ותפוצות</p>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewChatOpen(true)}
              className="gap-2"
            >
              <Plus className="h-4 w-4" /> שיחה חדשה
            </Button>
            <Button
              type="button"
              onClick={() => setBroadcastOpen(true)}
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Megaphone className="h-4 w-4" /> תפוצה
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2">
        <TabButton active={tab === 'chats'} onClick={() => setTab('chats')}>שיחות</TabButton>
        <TabButton active={tab === 'templates'} onClick={() => setTab('templates')}>תבניות</TabButton>
      </div>

      {/* Body */}
      {tab === 'chats' ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(300px,360px)_1fr]">
          <ConversationList
            conversations={conversations}
            selectedChatId={selected?.chat_id ?? null}
            onSelect={selectConversation}
            search={search}
            onSearch={setSearch}
            loading={loadingConvos}
            instances={instances}
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={setSelectedInstanceId}
            showInstanceSelector={isAdmin && instances.length > 1}
            className={cn(selected && 'hidden md:flex')}
          />
          <ChatThread
            conversation={selected}
            messages={thread}
            loading={loadingThread}
            canEdit={canEdit}
            instanceId={selectedInstanceId}
            onSent={handleSent}
            onBack={() => setSelected(null)}
            className={cn(!selected && 'hidden md:flex')}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <TemplatesTab canManage={canManageTemplates} />
        </div>
      )}

      {canEdit && (
        <>
          <NewConversationDialog
            open={newChatOpen}
            onOpenChange={setNewChatOpen}
            onStart={(c) => {
              setNewChatOpen(false);
              setTab('chats');
              selectConversation(c);
            }}
          />
          <BroadcastPanel open={broadcastOpen} onOpenChange={setBroadcastOpen} />
        </>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors',
        active
          ? 'bg-emerald-600 text-white'
          : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}
