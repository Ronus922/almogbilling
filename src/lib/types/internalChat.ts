// Internal Chat domain types — Module 4.
// In-app chat between system users. Reuses the notifications infra (023) for
// new-message alerts. All access is participant-scoped (no IDOR).

export type ConversationType = 'direct' | 'group';

export const MAX_MESSAGE_LENGTH = 4000;

/** A row from internal_conversations. */
export interface InternalConversation {
  id: string;
  type: ConversationType;
  name: string | null; // group name (null for direct)
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** A conversation enriched for the list view (current-user perspective). */
export interface ConversationSummary {
  id: string;
  type: ConversationType;
  /** Display title: group name, or the other participant's name for direct. */
  title: string;
  /** Names of all participants (for the thread-header subtitle / group avatar). */
  participant_names: string[];
  /** Number of participants. */
  participant_count: number;
  last_message_content: string | null;
  last_message_at: string | null;
  unread_count: number;
  /** Other participant's user id (direct only; null for group) — keys presence. */
  other_user_id: string | null;
  /** Other participant currently online (direct only; derived last_seen < 60s). */
  online: boolean;
}

/** One unread conversation for the dashboard widget (lean shape). */
export interface ChatUnreadConversation {
  id: string;
  title: string;
  last_message_content: string | null;
  last_message_at: string | null;
  unread_count: number;
}

/** Dashboard "internal messages" summary for the current user. */
export interface ChatUnreadSummary {
  /** Total unread messages across all the user's conversations. */
  total: number;
  /** Number of conversations with at least one unread message. */
  conversation_count: number;
  /** Most-recent unread conversations (capped). */
  conversations: ChatUnreadConversation[];
}

/** A single message row enriched with whether it belongs to the current user. */
export interface InternalMessage {
  id: string;
  conversation_id: string;
  sender_user_id: string | null;
  sender_name: string | null;
  content: string;
  created_at: string;
}

/** The full thread payload returned by GET .../messages. */
export interface ThreadPayload {
  conversation: {
    id: string;
    type: ConversationType;
    title: string;
    participant_names: string[];
    /** Other participant's user id (direct only; null for group) — keys presence. */
    other_user_id: string | null;
    /** Other participant currently online (direct only; derived last_seen < 60s). */
    online: boolean;
    /** Other participant's read cursor (direct only) — drives "read" receipts. */
    other_last_read_at: string | null;
    /** Other participant's last heartbeat (direct only) — drives "delivered". */
    other_last_seen_at: string | null;
  };
  messages: InternalMessage[];
}

/** Delivery state of one of MY messages in a 1:1 (derived client-side). */
export type ReceiptStatus = 'sent' | 'delivered' | 'read';

/** Realtime events on the shared in-process bus (reuses the WhatsApp SSE infra),
 *  delivered to the internal-chat SSE stream (/api/chat/stream).
 *  - presence: broadcast to all chat clients; client derives offline by TTL.
 *  - typing: scoped to `recipient_ids` (the conversation's other participants). */
export type ChatStreamEvent =
  | { type: 'presence'; user_id: string; online: boolean }
  | {
      type: 'typing';
      conversation_id: string;
      user_id: string;
      user_name: string;
      recipient_ids: string[];
    };
