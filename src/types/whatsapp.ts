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
//   POST   /api/whatsapp/messages/[id]/link     body: { debtor_id } → { ok, linked }
//   POST   /api/whatsapp/pull                   pull inbound (fallback) → { received, skipped }
//   POST   /api/whatsapp/webhook                PUBLIC — Green API inbound (bearer token)
//   GET    /api/debtors/search?q=…              → DebtorSearchResult[] (link dialog)
//   GET/PUT /api/settings/green-api             credentials (admin only)
//   POST    /api/settings/green-api/test        getStateInstance probe (admin only)
//   GET/POST /api/settings/green-api/webhook    inbound webhook status / register (admin)

export type ChatDirection = 'sent' | 'received';
export type ChatStatus = 'pending' | 'sent' | 'failed';
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
  contact_phone: string;
  chat_id: string | null;
  external_message_id: string | null;
  link_status: ChatLinkStatus;
  direction: ChatDirection;
  message_type: ChatMessageType;
  content: string | null;
  status: ChatStatus;
  error_detail: string | null;
  sent_by: string | null;
  sent_by_name: string | null;
  created_at: string;
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
