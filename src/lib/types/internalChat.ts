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
  };
  messages: InternalMessage[];
}
