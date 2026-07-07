'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  Conversation, ThreadMessage, InstanceOption, ChatStatus, ChatDirection, ChatMessageType,
  WaStreamEvent, UnlinkedMessage,
} from '@/types/whatsapp';
import { ConversationList } from './ConversationList';
import { ChatThread } from './ChatThread';
import { NewConversationDialog } from './NewConversationDialog';
import { TemplatesTab } from './TemplatesTab';
import { LinkDebtorDialog } from './LinkDebtorDialog';
import { LinkSupplierDialog } from './LinkSupplierDialog';
import { BroadcastPanel } from './BroadcastPanel';

// Real-time: SSE pushes updates instantly. Polling is now only a gap-filler —
// infrequent while the stream is healthy, dense while it's down.
const FALLBACK_SYNC_MS = 30_000; // SSE connected → reconcile every 30s
const DENSE_POLL_MS = 4_000;     // SSE down → fall back to dense polling

type Tab = 'chats' | 'templates';

/** Result the composer reports back after the send round-trip resolves. */
export interface SendResolution {
  ok: boolean;
  message_id?: string | null;
  idMessage?: string | null;
  error?: string;
  /** The fetch threw (network/unknown outcome) — the send may or may not have
   *  gone out, so we must NOT leave a terminal 'failed' bubble (it would
   *  duplicate the real row on the next sync if it actually sent). */
  unknown?: boolean;
}

// ─── pure thread/list merge helpers (no refetch — point updates) ───

// Monotonic status ranking so a late 'delivered' never overwrites a 'read'.
const STATUS_RANK: Record<ChatStatus, number> = {
  pending: 0, queued: 0, sent: 1, failed: 1, delivered: 2, read: 3,
};

function msgKey(m: ThreadMessage): string {
  return m.external_message_id || m.id;
}

function sortByCreated(list: ThreadMessage[]): ThreadMessage[] {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** Insert or merge a message by external-id/id (no duplicates). */
function upsertThread(prev: ThreadMessage[], msg: ThreadMessage): ThreadMessage[] {
  const k = msgKey(msg);
  const i = prev.findIndex((m) => msgKey(m) === k || m.id === msg.id);
  if (i >= 0) {
    const next = [...prev];
    next[i] = { ...next[i], ...msg };
    return next;
  }
  return sortByCreated([...prev, msg]);
}

/** Advance a message's delivery status (the ✓ ticks), monotonically. */
function applyStatus(prev: ThreadMessage[], externalId: string, status: ChatStatus): ThreadMessage[] {
  let changed = false;
  const next = prev.map((m) => {
    if (m.external_message_id === externalId && STATUS_RANK[status] > STATUS_RANK[m.status]) {
      changed = true;
      return { ...m, status };
    }
    return m;
  });
  return changed ? next : prev;
}

/** Replace the thread with server data but keep in-flight optimistic bubbles
 *  (tmp- ids the server hasn't caught up on yet). */
function reconcileThread(server: ThreadMessage[], prev: ThreadMessage[]): ThreadMessage[] {
  const serverKeys = new Set(server.map(msgKey));
  const serverIds = new Set(server.map((m) => m.id));
  const keepTmp = prev.filter(
    (m) => m.id.startsWith('tmp-')
      && !(m.external_message_id && serverKeys.has(m.external_message_id))
      && !serverIds.has(m.id),
  );
  return keepTmp.length ? sortByCreated([...server, ...keepTmp]) : server;
}

/** Bump a conversation's preview + move it to the top; optionally +1 unread. */
function bumpConversation(
  prev: Conversation[],
  chatId: string,
  patch: { content: string | null; type: ChatMessageType; direction: ChatDirection; incUnread: boolean },
  nowIso: string,
): Conversation[] {
  const i = prev.findIndex((c) => c.chat_id === chatId);
  if (i < 0) return prev;
  const c = prev[i];
  const updated: Conversation = {
    ...c,
    last_content: patch.content,
    last_type: patch.type,
    last_direction: patch.direction,
    last_at: nowIso,
    unread: patch.incUnread ? c.unread + 1 : c.unread,
  };
  return [updated, ...prev.filter((_, idx) => idx !== i)];
}

export function MessagesClient({
  canEdit,
  canLink,
  canCreateSupplier,
  canManageTemplates,
  isAdmin,
  currentUserId,
}: {
  canEdit: boolean;
  canLink: boolean;
  /** suppliers:edit — gates the "create supplier from this number" path. */
  canCreateSupplier: boolean;
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [supplierLinkOpen, setSupplierLinkOpen] = useState(false);

  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [sseUp, setSseUp] = useState(false);
  // Set when the stream repeatedly fails to even open (e.g. the session expired):
  // we stop reconnecting AND back the fallback poll off, so a dead auth state
  // can't turn into a 4s reconnect/poll storm against the server.
  const [sseFatal, setSseFatal] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  const searchRef = useRef('');
  const instanceRef = useRef<string | null>(null);
  const tmpCounter = useRef(0);
  selectedIdRef.current = selected?.chat_id ?? null;
  searchRef.current = search;
  instanceRef.current = selectedInstanceId;

  const instParam = useCallback(
    () => (instanceRef.current ? `&instance_id=${encodeURIComponent(instanceRef.current)}` : ''),
    [],
  );

  const fetchConversations = useCallback(async (q: string, silent = false) => {
    const reqInstance = instanceRef.current;
    if (!silent) setLoadingConvos(true);
    try {
      const r = await fetch(
        `/api/whatsapp/conversations?search=${encodeURIComponent(q)}${instParam()}`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as Conversation[];
      // Drop a stale response: the user switched instance while it was in flight.
      if (instanceRef.current !== reqInstance) return;
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
      // Reconcile (keep in-flight optimistic) and only for the still-open chat.
      if (selectedIdRef.current === chatId) setThread((prev) => reconcileThread(data, prev));
    } catch {
      if (!silent) toast.error('טעינת השיחה נכשלה');
    } finally {
      if (!silent) setLoadingThread(false);
    }
  }, [instParam]);

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

  // ─── real-time event handling (point updates, no refetch) ───
  const handleEvent = useCallback((ev: WaStreamEvent) => {
    if (ev.type === 'message_status') {
      setThread((prev) => applyStatus(prev, ev.external_message_id, ev.status));
      return;
    }
    const msg = ev.message;
    const isOpen = selectedIdRef.current === ev.chat_id;
    // A self-sent echo can beat the composer's own HTTP resolve back to this tab.
    // Adopt the matching still-pending optimistic bubble instead of appending a
    // duplicate (keeps multi-tab working: other tabs have no pending bubble and
    // just upsert normally).
    const isSelfEcho = ev.type === 'message_sent' && msg.sent_by === currentUserId;
    if (isOpen) {
      setThread((prev) => {
        if (isSelfEcho) {
          const i = prev.findIndex(
            (m) => m.id.startsWith('tmp-') && m.status === 'pending'
              && m.direction === 'sent' && m.content === msg.content,
          );
          if (i >= 0) {
            const next = [...prev];
            next[i] = { ...next[i], id: msg.id, external_message_id: msg.external_message_id, status: msg.status };
            return next;
          }
        }
        return upsertThread(prev, msg);
      });
      if (ev.type === 'message_received') void markRead(ev.chat_id);
    }
    setConversations((prev) => {
      if (!prev.some((c) => c.chat_id === ev.chat_id)) {
        // New conversation — pull it in (with debtor name/avatar) silently.
        void fetchConversations(searchRef.current, true);
        return prev;
      }
      return bumpConversation(prev, ev.chat_id, {
        content: msg.content,
        type: msg.message_type,
        direction: msg.direction,
        incUnread: ev.type === 'message_received' && !isOpen,
      }, msg.created_at);
    });
  }, [fetchConversations, markRead]);

  // Latest-callback refs so the SSE/poll effects don't reconnect on every render.
  const fetchConversationsRef = useRef(fetchConversations);
  const fetchThreadRef = useRef(fetchThread);
  const handleEventRef = useRef(handleEvent);
  fetchConversationsRef.current = fetchConversations;
  fetchThreadRef.current = fetchThread;
  handleEventRef.current = handleEvent;

  // Load instances; default to own, else first.
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
        /* selector optional */
      }
    })();
    return () => { cancelled = true; };
  }, [currentUserId]);

  // Initial load + reload when the viewed instance changes.
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

  // SSE stream — instant push of received/sent/status. Manual reconnect with
  // exponential backoff; reconnects when the viewed instance changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let stopped = false;
    let backoff = 1000;
    let failStreak = 0; // consecutive cycles that errored WITHOUT ever opening
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    setSseFatal(false); // fresh chance whenever the instance (effect) changes

    const connect = () => {
      let openedThisCycle = false;
      const q = instanceRef.current ? `?instance_id=${encodeURIComponent(instanceRef.current)}` : '';
      es = new EventSource(`/api/whatsapp/stream${q}`, { withCredentials: true });

      es.addEventListener('open', () => {
        openedThisCycle = true;
        failStreak = 0;
        backoff = 1000;
        setSseUp(true);
        setSseFatal(false);
        // Catch up on anything missed during (re)connect.
        void fetchConversationsRef.current(searchRef.current, true);
        const cid = selectedIdRef.current;
        if (cid) void fetchThreadRef.current(cid, true);
      });

      const onEvt = (e: MessageEvent) => {
        try { handleEventRef.current(JSON.parse(e.data) as WaStreamEvent); } catch { /* ignore */ }
      };
      es.addEventListener('message_received', onEvt);
      es.addEventListener('message_sent', onEvt);
      es.addEventListener('message_status', onEvt);

      es.addEventListener('error', () => {
        setSseUp(false);
        es?.close();
        es = null;
        if (stopped) return;
        failStreak = openedThisCycle ? 0 : failStreak + 1;
        // Never opened across several tries → treat as fatal (likely auth/session
        // gone). Stop reconnecting; the fallback poll backs off too.
        if (failStreak >= 4) {
          setSseFatal(true);
          return;
        }
        reconnect = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      es?.close();
      setSseUp(false);
    };
  }, [selectedInstanceId]);

  // Fallback sync: rare while SSE is healthy; dense while it's transiently down;
  // backed off again once the stream is deemed fatally down (no storm on auth loss).
  useEffect(() => {
    const ms = sseUp || sseFatal ? FALLBACK_SYNC_MS : DENSE_POLL_MS;
    const id = setInterval(() => {
      void fetchConversationsRef.current(searchRef.current, true);
      const cid = selectedIdRef.current;
      if (cid) void fetchThreadRef.current(cid, true);
    }, ms);
    return () => clearInterval(id);
  }, [sseUp, sseFatal]);

  const selectConversation = useCallback(
    (c: Conversation) => {
      setSelected(c);
      setThread([]);
      void fetchThread(c.chat_id);
      setConversations((prev) => prev.map((x) => (x.chat_id === c.chat_id ? { ...x, unread: 0 } : x)));
      if (c.unread > 0) void markRead(c.chat_id);
    },
    [fetchThread, markRead],
  );

  // ─── optimistic send (instant bubble, server resolves in the background) ───
  const optimisticSend = useCallback((chatId: string, text: string): string => {
    tmpCounter.current += 1;
    const tmpId = `tmp-${Date.now()}-${tmpCounter.current}`;
    const nowIso = new Date().toISOString();
    const optimistic: ThreadMessage = {
      id: tmpId, debtor_id: null, supplier_id: null, contact_phone: '', chat_id: chatId,
      external_message_id: null, link_status: 'linked', direction: 'sent', message_type: 'text',
      content: text, media_url: null, status: 'pending', error_detail: null, sent_by: currentUserId,
      sent_by_name: null, supplier_display_name: null, broadcast_id: null, read_at: null, created_at: nowIso,
    };
    if (selectedIdRef.current === chatId) setThread((prev) => sortByCreated([...prev, optimistic]));
    setConversations((prev) => bumpConversation(prev, chatId, {
      content: text, type: 'text', direction: 'sent', incUnread: false,
    }, nowIso));
    return tmpId;
  }, [currentUserId]);

  const resolveSend = useCallback((tmpId: string, res: SendResolution) => {
    // Unknown outcome (fetch threw): the message may have gone out. Drop the
    // optimistic bubble and let the SSE echo / a thread refetch show the true
    // state — never a stuck 'failed' that would duplicate a real sent row.
    if (!res.ok && res.unknown) {
      setThread((prev) => prev.filter((m) => m.id !== tmpId));
      const cid = selectedIdRef.current;
      if (cid) void fetchThreadRef.current(cid, true);
      return;
    }
    setThread((prev) => prev.map((m) => {
      if (m.id !== tmpId) return m;
      return res.ok
        ? { ...m, id: res.message_id ?? m.id, external_message_id: res.idMessage ?? null, status: 'sent' as ChatStatus }
        : { ...m, id: res.message_id ?? m.id, status: 'failed' as ChatStatus, error_detail: res.error ?? 'שליחה נכשלה' };
    }));
  }, []);

  // After a non-optimistic action (file send / resend) refresh point-wise.
  const handleSent = useCallback(() => {
    const cid = selectedIdRef.current;
    if (cid) void fetchThread(cid, true);
    void fetchConversations(searchRef.current, true);
  }, [fetchThread, fetchConversations]);

  // After a successful link: refetch the list, promote the now-linked conversation
  // into the open header (no manual refresh), and reload its thread.
  const handleLinked = useCallback(async () => {
    setLinkOpen(false);
    setSupplierLinkOpen(false);
    const cid = selectedIdRef.current;
    try {
      const r = await fetch(
        `/api/whatsapp/conversations?search=${encodeURIComponent(searchRef.current)}${instParam()}`,
        { credentials: 'include' },
      );
      if (r.ok) {
        const data = (await r.json()) as Conversation[];
        setConversations(data);
        if (cid) {
          const updated = data.find((c) => c.chat_id === cid);
          if (updated) setSelected(updated);
        }
      }
    } catch {
      /* the fallback poll will reconcile */
    }
    if (cid) void fetchThread(cid, true);
  }, [instParam, fetchThread]);

  // Build a link-dialog target from the open conversation: any message in the
  // thread supplies the id the link endpoint keys off (it then updates every row
  // sharing that chat_id). Prefers an unlinked row, else the first message — so
  // it works for both initial linking and re-linking an already-linked chat.
  const buildLinkTarget = useCallback((): UnlinkedMessage | null => {
    if (!selected) return null;
    const m = thread.find((x) => x.link_status === 'unlinked') ?? thread[0];
    if (!m) return null;
    return {
      id: m.id,
      contact_phone: selected.phone ?? m.contact_phone,
      chat_id: selected.chat_id,
      message_type: m.message_type,
      content: m.content,
      created_at: m.created_at,
    };
  }, [selected, thread]);

  const linkTarget: UnlinkedMessage | null = linkOpen ? buildLinkTarget() : null;
  const supplierLinkTarget: UnlinkedMessage | null = supplierLinkOpen ? buildLinkTarget() : null;

  // Detach the open conversation (XOR-safe — clears both debtor + supplier). Keys
  // off any message id; the endpoint updates the whole chat_id back to unlinked.
  const handleUnlink = useCallback(async () => {
    const target = buildLinkTarget();
    if (!target) return;
    try {
      const r = await fetch(`/api/whatsapp/messages/${target.id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ unlink: true }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success('השיוך נותק');
      await handleLinked();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [buildLinkTarget, handleLinked]);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[13px] bg-[#e7f7ee] text-green-600">
            <MessageCircle className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">הודעות</h1>
            <p className="text-sm text-muted-foreground">צ׳אט וואטסאפ — שיחות ותפוצות</p>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setNewChatOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" /> שיחה חדשה
            </Button>
            <Button
              type="button"
              variant="approve"
              onClick={() => setBroadcastOpen(true)}
              className="gap-2 shadow-[0_8px_18px_-7px_rgba(22,163,74,0.6)] hover:bg-green-700"
            >
              <Megaphone className="h-4 w-4" /> תפוצות
            </Button>
          </div>
        )}
      </div>

      {/* Tabs — segmented control (DESIGN §16 colors: active blue, idle muted) */}
      <div className="inline-flex w-fit items-center gap-1 rounded-xl bg-slate-100 p-1">
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
            canLink={canLink}
            instanceId={selectedInstanceId}
            onOptimisticSend={optimisticSend}
            onResolveSend={resolveSend}
            onSent={handleSent}
            onRequestLink={() => setLinkOpen(true)}
            onRequestLinkSupplier={() => setSupplierLinkOpen(true)}
            onUnlink={handleUnlink}
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
          <BroadcastPanel open={broadcastOpen} onOpenChange={setBroadcastOpen} canEdit={canEdit} />
        </>
      )}

      {canLink && (
        <>
          <LinkDebtorDialog
            message={linkTarget}
            onOpenChange={(o) => { if (!o) setLinkOpen(false); }}
            onLinked={handleLinked}
          />
          <LinkSupplierDialog
            message={supplierLinkTarget}
            canCreate={canCreateSupplier}
            onOpenChange={(o) => { if (!o) setSupplierLinkOpen(false); }}
            onLinked={handleLinked}
          />
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
          ? 'bg-green-600 text-white shadow-sm'
          : 'bg-transparent text-slate-600 hover:bg-white',
      )}
    >
      {children}
    </button>
  );
}
