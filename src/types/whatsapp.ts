// Shared contract for the WhatsApp module (outbound sending — phase 1).
// Consumed by API routes, DB helpers and UI components.
//
// API routes (signatures):
//   GET    /api/whatsapp/templates              → WhatsAppTemplate[]   (active; ?scope=all for management)
//   POST   /api/whatsapp/templates              body: TemplateInput
//   PATCH  /api/whatsapp/templates/[id]         body: Partial<TemplateInput>
//   DELETE /api/whatsapp/templates/[id]         (soft delete → is_active=false)
//   POST   /api/whatsapp/send                   body: SendWhatsAppInput → { ok, idMessage }
//   POST   /api/whatsapp/send-bulk              body: BulkSendInput → NDJSON stream of
//                                                 BulkSendProgress… + BulkSendSummary
//   GET    /api/whatsapp/messages?debtor_id=…   → ChatMessage[]        (chronological)
//   GET    /api/whatsapp/unlinked               → UnlinkedMessage[]    (inbound, no debtor)
//   POST   /api/whatsapp/messages/[id]/link     body: { debtor_id } | { supplier_id } | { unlink: true } → { ok, linked }
//                                                 (XOR: a conversation links to a debtor OR a supplier OR neither)
//   POST   /api/whatsapp/messages/[id]/create-supplier  body: { display_name, category_id? } → { id, linked }
//                                                 (creates a supplier from the conversation's number, then links it)
//   GET    /api/suppliers/search?q=…             → SupplierSearchResult[] (supplier link dialog; whatsapp:edit)
//   POST   /api/whatsapp/pull                   pull inbound (fallback) → { received, skipped }
//   POST   /api/webhooks/greenapi              PUBLIC — Green API inbound (canonical; ?secret= query param)
//   GET    /api/debtors/search?q=…              → DebtorSearchResult[] (link dialog)
//   (Per-employee Green API instances are managed via /api/whatsapp/instances/*;
//    the canonical inbound webhook receiver is POST /api/webhooks/greenapi.)

export type ChatDirection = 'sent' | 'received';
/** Outgoing delivery lifecycle. Inbound rows are stored as 'sent' (already
 *  delivered). 'queued' is used while a broadcast is in flight; 'delivered' /
 *  'read' come from the outgoingMessageStatus webhook. */
export type ChatStatus = 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type ChatMessageType = 'text' | 'image' | 'document';
export type ChatLinkStatus = 'linked' | 'unlinked';

export interface WhatsAppTemplate {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateInput {
  name: string;
  content: string;
  is_active?: boolean;
}

export interface ChatMessage {
  id: string;
  debtor_id: string | null;
  /** Linked supplier id — set instead of debtor_id when the conversation is
   *  attached to an external supplier (XOR with debtor_id). */
  supplier_id: string | null;
  contact_phone: string;
  chat_id: string | null;
  external_message_id: string | null;
  link_status: ChatLinkStatus;
  direction: ChatDirection;
  message_type: ChatMessageType;
  content: string | null;
  media_url: string | null;
  /** Original (Hebrew) file name of an outbound attachment. Optional: absent on
   *  synthetic/optimistic rows built in code; always present on DB rows. */
  attachment_name?: string | null;
  /** Attachment MIME type (drives the history icon). */
  attachment_mime?: string | null;
  /** Attachment size in bytes. */
  attachment_size?: number | null;
  status: ChatStatus;
  error_detail: string | null;
  sent_by: string | null;
  sent_by_name: string | null;
  /** Joined supplier display name when supplier_id is set, else null. */
  supplier_display_name: string | null;
  broadcast_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** Lightweight supplier row for the "link conversation to supplier" dialog.
 *  Served by GET /api/suppliers/search (gated on whatsapp:edit, NOT
 *  suppliers:view) so the linking flow works without supplier-read access —
 *  mirrors DebtorSearchResult / /api/debtors/search. */
export interface SupplierSearchResult {
  id: string;
  display_name: string;
  phone: string;
  mobile: string;
  category_name: string | null;
}

export interface SendWhatsAppInput {
  debtor_id: string;
  message: string;
  template_id?: string | null;
  /** Selected recipient number (international form). Re-validated server-side
   *  against the debtor's parsed candidates. Omitted → first valid candidate. */
  phone?: string | null;
}

export interface GreenApiSettingsPublic {
  instanceId: string;
  hasToken: boolean;
}

// ─── Inbound (phase 2) ───

/** A received message that hasn't been matched to a debtor — the unlinked inbox. */
export interface UnlinkedMessage {
  id: string;
  contact_phone: string;
  chat_id: string | null;
  message_type: ChatMessageType;
  content: string | null;
  created_at: string;
}

/** Inbound webhook registration status (GET /api/settings/green-api/webhook). */
export interface GreenApiWebhookStatus {
  registered: boolean;
  incomingEnabled: boolean;
  /** The webhook URL currently set on the Green API instance, if any. */
  webhookUrl: string | null;
  /** The URL this app expects to be registered. */
  expectedUrl: string;
}

// ─── Bulk send (phase 2) ───

export interface BulkSendInput {
  debtor_ids: string[];
  message: string;
  template_id?: string | null;
}

/** One NDJSON progress line streamed by POST /api/whatsapp/send-bulk. */
export interface BulkSendProgress {
  type: 'progress';
  index: number;
  total: number;
  apartment: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
}

export interface BulkSendFailure {
  apartment: string;
  error: string;
}

/** The final NDJSON line streamed by POST /api/whatsapp/send-bulk. */
export interface BulkSendSummary {
  type: 'summary';
  sent: number;
  failed: number;
  skipped: number;
  failures: BulkSendFailure[];
}

// ─────────────────────────────────────────────────────────────────────
// Conversational inbox (Slice 6) — the /messages two-panel chat.
// A conversation groups chat_messages by chat_id (the "<digits>@c.us" key,
// stable across inbound + outbound). Threads, sending and broadcasts all key
// off chat_id. There is no separate contacts table in this project, so a
// conversation links to a `debtor` (matched by phone), not a generic contact.
// ─────────────────────────────────────────────────────────────────────

/** One row in the conversation list (right panel). */
export interface Conversation {
  /** Grouping key — the Green API chat id ("972XXXXXXXXX@c.us" or a group "…@g.us"). */
  chat_id: string;
  /** Sender phone in local form ("0XXXXXXXXX"), or the raw value for groups. */
  phone: string | null;
  /** true when chat_id ends with @g.us (a WhatsApp group). */
  is_group: boolean;
  /** Linked debtor id, or null for an unmatched number. */
  debtor_id: string | null;
  /** Linked supplier id (XOR with debtor_id), or null. When set, the conversation
   *  is attached to an external supplier rather than an apartment. */
  supplier_id: string | null;
  /** Joined supplier name when supplier_id is set — drives the amber supplier
   *  badge in the thread header. */
  supplier_display_name: string | null;
  /** Display name: the linked debtor's name, else null (UI falls back to phone). */
  display_name: string | null;
  apartment_number: string | null;
  /** Which debtor phone field this conversation's number matched — drives the
   *  "בעלים" / "שוכר: {name}" role line in the list. null when unlinked or when
   *  a manually-linked debtor's phones don't include this number. */
  role: 'owner' | 'tenant' | null;
  /** The linked debtor's tenant name (for the "שוכר: {name}" role line). */
  tenant_name: string | null;
  /** Last message preview. */
  last_content: string | null;
  last_type: ChatMessageType;
  last_direction: ChatDirection;
  last_at: string;
  /** Count of inbound messages not yet marked read. */
  unread: number;
  /** Cached WhatsApp profile-picture URL (an expiring CDN link), or null. */
  avatar_url: string | null;
}

/** A message inside an open thread (left panel). Same shape as ChatMessage. */
export type ThreadMessage = ChatMessage;

/**
 * Real-time events pushed over GET /api/whatsapp/stream (SSE). Each carries the
 * instance_id so the client can ignore events for an instance it isn't viewing.
 *   • message_received — a new inbound message arrived.
 *   • message_sent     — a new outbound message was stored (composer / phone echo).
 *   • message_status   — an outbound message's delivery status advanced (the ✓ ticks).
 */
export type WaStreamEvent =
  | { type: 'message_received'; instance_id: string; chat_id: string; message: ThreadMessage }
  | { type: 'message_sent'; instance_id: string; chat_id: string; message: ThreadMessage }
  | { type: 'message_status'; instance_id: string; external_message_id: string; status: ChatStatus };

export type InstanceState =
  | 'notAuthorized' | 'authorized' | 'blocked' | 'starting' | 'yellowCard' | 'sleepMode';

/** A WhatsApp instance as exposed to the inbox selector (token-free). */
export interface InstanceOption {
  id: string;
  user_id: string;
  display_name: string;
  green_instance_id: string;
  api_url: string;
  state: InstanceState;
  state_checked_at: string | null;
  created_at: string;
  owner_name: string | null;
  owner_username: string | null;
}

/** Resolved target for "new conversation" / composer send. */
export interface NewChatTarget {
  /** Phone in international form ("972XXXXXXXXX"). */
  phoneIntl: string;
  chat_id: string;
  debtor_id: string | null;
}

// ─── Broadcasts ───

export type BroadcastStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Audience kinds. "owners"/"tenants" pick the matching debtor phone field;
 *  "all" = every non-archived debtor with any valid phone; "debtor_ids" = an
 *  explicit list (the task's contact_ids, mapped to debtors). */
export type BroadcastAudienceType = 'all' | 'owners' | 'tenants';

export interface BroadcastAudience {
  type: BroadcastAudienceType | 'debtor_ids';
  /** Present only when type === 'debtor_ids'. */
  debtor_ids?: string[];
}

export interface Broadcast {
  id: string;
  name: string;
  body: string;
  audience_filter: BroadcastAudience;
  total_count: number;
  sent_count: number;
  failed_count: number;
  status: BroadcastStatus;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BroadcastInput {
  name: string;
  /** Free-text body. Mutually exclusive with template_id (one is required). */
  body?: string | null;
  template_id?: string | null;
  audience: BroadcastAudience;
}
