// Shared contract for the WhatsApp module (outbound sending — phase 1).
// Consumed by API routes, DB helpers and UI components.
//
// API routes (signatures):
//   GET    /api/whatsapp/templates              → WhatsAppTemplate[]   (active; ?scope=all for management)
//   POST   /api/whatsapp/templates              body: TemplateInput
//   PATCH  /api/whatsapp/templates/[id]         body: Partial<TemplateInput>
//   DELETE /api/whatsapp/templates/[id]         (soft delete → is_active=false)
//   POST   /api/whatsapp/send                   body: SendWhatsAppInput → { ok, idMessage }
//   GET    /api/whatsapp/messages?debtor_id=…   → ChatMessage[]        (chronological)
//   GET/PUT /api/settings/green-api             credentials (admin only)
//   POST    /api/settings/green-api/test        getStateInstance probe (admin only)

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
