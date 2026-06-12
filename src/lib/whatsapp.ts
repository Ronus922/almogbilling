// Green API (green-api.com) outbound client + Israeli phone normalisation.
// Phase 1: text messages only. No webhooks / inbound handling yet.
//
// NOT `server-only`: parsePhoneCandidates / normalizePhone are pure helpers used
// by client components (the send panel + the debtors table) to decide validity
// and render the recipient picker. The network functions below take an explicit
// instanceId/token (no secret import), so they're never wired from the browser.

import type { ChatStatus } from '@/types/whatsapp';

const GREEN_API_BASE = 'https://api.green-api.com';

/** Thrown for anything WhatsApp-specific. Route layer maps to a real HTTP error
 *  (never a 200) so the client toast reflects the true outcome. */
export class WhatsAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

export interface NormalizedPhone {
  /** International digits, e.g. "972541234567". */
  phone: string;
  /** Green API chat id, e.g. "972541234567@c.us". */
  chatId: string;
}

/**
 * Normalises a raw Israeli phone string into Green API's `<digits>@c.us` chatId.
 *
 * Steps:
 *   1. Take the first token (Excel cells like "0541234567 / 0521234567").
 *   2. Strip every non-digit.
 *   3. Drop a "00" international prefix.
 *   4. Leading 0 → 972; bare 9-digit subscriber numbers → prefix 972.
 *   5. Validate the result is 972 + 8–9 subscriber digits (mobile/landline).
 *
 * Throws WhatsAppError on anything that doesn't resolve to a valid IL number.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw || !String(raw).trim()) {
    throw new WhatsAppError('מספר טלפון חסר');
  }

  const first = String(raw).split(/[\/,;|]+/)[0]?.trim() ?? '';
  let digits = first.replace(/\D+/g, '');
  if (!digits) throw new WhatsAppError(`מספר טלפון לא תקין: ${raw}`);

  // International "00" prefix → drop it.
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('972')) {
    // already international — keep as-is
  } else if (digits.startsWith('0')) {
    digits = '972' + digits.slice(1);
  } else if (digits.length === 9 && /^[2-9]/.test(digits)) {
    // subscriber digits without the trunk 0 (e.g. "541234567")
    digits = '972' + digits;
  }

  // IL mobile → 972 + 9 digits (12 total); landline → 972 + 8 digits (11 total).
  if (!/^972\d{8,9}$/.test(digits)) {
    throw new WhatsAppError(`מספר טלפון לא תקין: ${raw}`);
  }

  return { phone: digits, chatId: `${digits}@c.us` };
}

export interface PhoneCandidate {
  /** Normalised international digits, e.g. "972525460546". */
  phone: string;
  /** Role/label captured from "(…)" after the number (e.g. "בעלים"), or null. */
  label: string | null;
}

/**
 * Validate a clean digit string against the acceptance rule and return its
 * international form, or null:
 *   • 9–10 digits starting with 0    → local landline / mobile (0 → 972)
 *   • 9  digits starting with 2–9    → subscriber number missing the trunk 0
 *                                       (e.g. CRM "523344580" → 0523344580)
 *   • 11–12 digits starting with 972 → already international
 * All-zero placeholders ("0000000000") are rejected.
 */
function normalizeParsedDigits(digits: string): string | null {
  if (!digits || /^0+$/.test(digits)) return null;
  let intl: string | null = null;
  if ((digits.length === 9 || digits.length === 10) && digits.startsWith('0')) {
    intl = '972' + digits.slice(1);
  } else if (digits.length === 9 && /^[2-9]/.test(digits)) {
    intl = '972' + digits;
  } else if ((digits.length === 11 || digits.length === 12) && digits.startsWith('972')) {
    intl = digits;
  }
  if (!intl) return null;
  return /^972\d{8,9}$/.test(intl) ? intl : null;
}

/**
 * Strips link/protocol wrappers that sometimes contaminate phone fields:
 *   • Markdown link "[text](href)"  → "text"   (the href is dropped — text and
 *     the tel: number are identical, and the dedup below covers edge cases)
 *   • bare "tel:" prefix            → removed
 * Real role labels like "(בעלים)" are NOT preceded by "[...]", so they survive.
 * Shared by parsePhoneCandidates and the entry-point cleaners — single source.
 */
export function stripPhoneMarkup(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\btel:/gi, '');
}

/** International "972XXXXXXXXX" → local "0XXXXXXXXX" (the DB canonical form). */
function intlToLocal(intl: string): string {
  return '0' + intl.slice(3);
}

/**
 * Parses a debtor phone field that may be a compound string such as
 * "0525460546 (בעלים) 0000000000 (שוכר/ת)" into a de-duplicated list of valid
 * candidates with their role label.
 *
 * - Anchors on "(label)": every number inherits the label that closes its
 *   segment; numbers after the last label get null.
 * - Within a segment, dash/space/dot-separated digit groups are greedily
 *   recombined into one number ("052-546-0546" → one), while two complete
 *   numbers stay separate.
 * - Invalid / placeholder sequences (0000000000, wrong length/prefix) are dropped.
 */
export function parsePhoneCandidates(raw: string | null | undefined): PhoneCandidate[] {
  if (!raw || !String(raw).trim()) return [];

  // Strip Markdown / tel: wrappers before parsing (shared helper).
  const s = stripPhoneMarkup(String(raw));

  interface Seg { text: string; label: string | null }
  const segments: Seg[] = [];
  const labelRe = /[(（]([^)）]*)[)）]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(s)) !== null) {
    segments.push({ text: s.slice(lastIndex, m.index), label: m[1].trim() || null });
    lastIndex = labelRe.lastIndex;
  }
  segments.push({ text: s.slice(lastIndex), label: null });

  const out: PhoneCandidate[] = [];
  const seen = new Set<string>();

  for (const seg of segments) {
    const groups = seg.text.split(/[^0-9]+/).filter(Boolean);
    let buffer = '';
    for (const g of groups) {
      buffer += g;
      const norm = normalizeParsedDigits(buffer);
      if (norm) {
        if (!seen.has(norm)) {
          seen.add(norm);
          out.push({ phone: norm, label: seg.label });
        }
        buffer = '';
      }
    }
  }

  return out;
}

/**
 * Cleans a raw phone field down to ONE local-format number ("0XXXXXXXXX") or
 * null. Handles Markdown / tel: / labels / multiple numbers (takes the first
 * valid candidate). This is the DB canonical: phone fields store a single clean
 * local number with no labels/markup. Built on parsePhoneCandidates — no
 * duplicated parsing logic.
 */
export function cleanPhoneField(raw: string | null | undefined): string | null {
  const candidates = parsePhoneCandidates(raw);
  return candidates.length > 0 ? intlToLocal(candidates[0].phone) : null;
}

/**
 * Splits a (possibly compound, labelled) phone field into clean local owner /
 * tenant numbers by their "(בעלים)" / "(שוכר)"/"(שוכר/ת)" labels. An unlabelled
 * number falls to `owner` (the default field it came from); a second unlabelled
 * number falls to `tenant`. Used by the import/sync entry points and the
 * cleanup migration. Returns local format (or null per field).
 */
export function splitOwnerTenantPhones(
  raw: string | null | undefined,
): { owner: string | null; tenant: string | null } {
  const candidates = parsePhoneCandidates(raw);
  let owner: string | null = null;
  let tenant: string | null = null;
  const unlabeled: string[] = [];

  for (const c of candidates) {
    const local = intlToLocal(c.phone);
    const label = (c.label ?? '').trim();
    if (/בעל/.test(label)) {
      if (!owner) owner = local;
    } else if (/שוכר/.test(label)) {
      if (!tenant) tenant = local;
    } else {
      unlabeled.push(local);
    }
  }

  if (!owner && unlabeled.length > 0) owner = unlabeled.shift() ?? null;
  if (!tenant && unlabeled.length > 0) tenant = unlabeled.shift() ?? null;

  return { owner, tenant };
}

// ─────────────────────────────────────────────────────────────────────
// Inbound (phase 2) — pure parsing of Green API notifications.
// Both the live webhook POST and the lastIncomingMessages pull are reduced to
// one normalised ParsedIncoming shape so a single processIncomingMessage()
// (server-only) handles dedup + debtor cross-reference + insert. These helpers
// are pure (no DB / no secret) so they're fully unit-testable.
// ─────────────────────────────────────────────────────────────────────

export type IncomingMessageType = 'text' | 'image' | 'document';

export interface ParsedIncoming {
  /** Green API idMessage — the dedup key (chat_messages.external_message_id). */
  externalMessageId: string;
  /** Full Green API chat id, e.g. "972541234567@c.us" (or a group "…@g.us"). */
  chatId: string;
  /** Sender phone in the DB-canonical local form "0XXXXXXXXX". For groups this
   *  is the participant who sent the message (Green API senderData.sender). */
  senderPhoneLocal: string;
  messageType: IncomingMessageType;
  /** Text body, or — for files — the Green API downloadUrl. */
  content: string;
  /** Unix seconds from the gateway, or null (then the DB default now() applies). */
  timestamp: number | null;
  /** true when chatId is a WhatsApp group ("…@g.us") — never matched to a single
   *  debtor (the conversation keys on the group id, not the sender). */
  isGroup?: boolean;
}

/**
 * Green API person chat id ("972XXXXXXXXX@c.us") → local "0XXXXXXXXX".
 * Group chats ("…@g.us") and anything that doesn't resolve to a valid IL number
 * return null (skipped — not a debtor DM).
 */
export function chatIdToLocalPhone(chatId: string | null | undefined): string | null {
  if (!chatId || typeof chatId !== 'string') return null;
  const at = chatId.indexOf('@');
  const suffix = at >= 0 ? chatId.slice(at + 1) : '';
  if (suffix && suffix.toLowerCase() !== 'c.us') return null; // groups / broadcasts
  const digits = (at >= 0 ? chatId.slice(0, at) : chatId).replace(/\D+/g, '');
  const intl = normalizeParsedDigits(digits);
  return intl ? intlToLocal(intl) : null;
}

/** Map a Green API typeMessage + raw fields to our (messageType, content), or null. */
function classifyIncoming(
  typeMessage: string,
  fields: { text: string | null; downloadUrl: string | null },
): { messageType: IncomingMessageType; content: string } | null {
  switch (typeMessage) {
    case 'textMessage':
    case 'extendedTextMessage':
    case 'quotedMessage': {
      const text = (fields.text ?? '').trim();
      return text ? { messageType: 'text', content: text } : null;
    }
    case 'imageMessage':
      return fields.downloadUrl ? { messageType: 'image', content: fields.downloadUrl } : null;
    case 'documentMessage':
    case 'videoMessage':
    case 'audioMessage':
    case 'voiceMessage':
      // Any non-image file is stored as a 'document' link (the schema's file types).
      return fields.downloadUrl ? { messageType: 'document', content: fields.downloadUrl } : null;
    default:
      return null;
  }
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Parse a live webhook POST body (shape: { typeWebhook, idMessage, senderData,
 * messageData, timestamp }). Returns null for any non-incoming notification
 * (delivery receipts, state changes, outgoing, groups, unsupported types).
 */
export function parseWebhookNotification(payload: unknown): ParsedIncoming | null {
  const body = asObj(payload);
  if (body.typeWebhook !== 'incomingMessageReceived') return null;

  const externalMessageId = asStr(body.idMessage);
  if (!externalMessageId) return null;

  const senderData = asObj(body.senderData);
  const chatId = asStr(senderData.chatId);
  if (!chatId) return null;
  const senderPhoneLocal = chatIdToLocalPhone(chatId);
  if (!senderPhoneLocal) return null;

  const messageData = asObj(body.messageData);
  const typeMessage = asStr(messageData.typeMessage) ?? '';
  const textMessageData = asObj(messageData.textMessageData);
  const extendedTextMessageData = asObj(messageData.extendedTextMessageData);
  const fileMessageData = asObj(messageData.fileMessageData);

  const classified = classifyIncoming(typeMessage, {
    text: asStr(textMessageData.textMessage) ?? asStr(extendedTextMessageData.text),
    downloadUrl: asStr(fileMessageData.downloadUrl),
  });
  if (!classified) return null;

  return {
    externalMessageId,
    chatId,
    senderPhoneLocal,
    messageType: classified.messageType,
    content: classified.content,
    timestamp: asNum(body.timestamp),
  };
}

/**
 * Group-aware variant of parseWebhookNotification used by the canonical webhook
 * (/api/webhooks/greenapi). Identical to the person-only parser, except:
 *   • The conversation key (chatId) is senderData.chatId verbatim — a group id
 *     "…@g.us" is kept (the group is one conversation) instead of being skipped.
 *   • senderPhoneLocal comes from senderData.sender (the participant) for groups,
 *     falling back to chatId for person chats where sender === chatId.
 *   • isGroup is set so the inbound processor never matches a group to a single
 *     debtor.
 * Returns null only when there's no usable id / chat / sender / supported body.
 */
export function parseWebhookNotificationFull(payload: unknown): ParsedIncoming | null {
  const body = asObj(payload);
  if (body.typeWebhook !== 'incomingMessageReceived') return null;

  const externalMessageId = asStr(body.idMessage);
  if (!externalMessageId) return null;

  const senderData = asObj(body.senderData);
  const chatId = asStr(senderData.chatId);
  if (!chatId) return null;

  const isGroup = chatId.toLowerCase().endsWith('@g.us');
  // For groups the sender is the participant; for person chats sender === chatId.
  const sender = asStr(senderData.sender) ?? chatId;
  const senderPhoneLocal = chatIdToLocalPhone(sender);
  if (!senderPhoneLocal) return null; // can't attribute the message → skip

  const messageData = asObj(body.messageData);
  const typeMessage = asStr(messageData.typeMessage) ?? '';
  const textMessageData = asObj(messageData.textMessageData);
  const extendedTextMessageData = asObj(messageData.extendedTextMessageData);
  const fileMessageData = asObj(messageData.fileMessageData);

  const classified = classifyIncoming(typeMessage, {
    text: asStr(textMessageData.textMessage) ?? asStr(extendedTextMessageData.text),
    downloadUrl: asStr(fileMessageData.downloadUrl),
  });
  if (!classified) return null;

  return {
    externalMessageId,
    chatId,
    senderPhoneLocal,
    messageType: classified.messageType,
    content: classified.content,
    timestamp: asNum(body.timestamp),
    isGroup,
  };
}

/** Maps a Green API outgoing status string to our ChatStatus, or null if it
 *  isn't a status we track (then the row keeps its current status). */
function mapOutgoingStatus(raw: string): ChatStatus | null {
  switch (raw) {
    case 'sent':       return 'sent';
    case 'delivered':  return 'delivered';
    case 'read':
    case 'played':     return 'read';
    case 'failed':
    case 'noAccount':
    case 'notInGroup':
    case 'yellowCard': return 'failed';
    case 'pending':    return 'queued';
    default:           return null;
  }
}

export interface ParsedOutgoingStatus {
  externalMessageId: string;
  status: ChatStatus;
}

/** Parse an `outgoingMessageStatus` webhook → the message id + mapped status, or
 *  null for any other notification / untracked status. */
export function parseOutgoingStatus(payload: unknown): ParsedOutgoingStatus | null {
  const body = asObj(payload);
  if (body.typeWebhook !== 'outgoingMessageStatus') return null;
  const externalMessageId = asStr(body.idMessage);
  if (!externalMessageId) return null;
  const status = mapOutgoingStatus(asStr(body.status) ?? '');
  if (!status) return null;
  return { externalMessageId, status };
}

export interface ParsedOutgoing {
  externalMessageId: string;
  chatId: string;
  /** Recipient phone, local form. */
  recipientPhoneLocal: string;
  messageType: IncomingMessageType;
  content: string;
  timestamp: number | null;
}

/**
 * Parse an `outgoingMessageReceived` (sent from the phone) or
 * `outgoingAPIMessageReceived` (sent via the API) webhook into an outbound row.
 * Lets the inbox reflect messages a user sent from the actual WhatsApp app.
 * Dedup downstream (ON CONFLICT external_message_id) makes API-originated echoes
 * — which we already stored at send time — harmless. Groups are skipped.
 */
export function parseOutgoingMessage(payload: unknown): ParsedOutgoing | null {
  const body = asObj(payload);
  const t = body.typeWebhook;
  if (t !== 'outgoingMessageReceived' && t !== 'outgoingAPIMessageReceived') return null;

  const externalMessageId = asStr(body.idMessage);
  if (!externalMessageId) return null;

  const senderData = asObj(body.senderData);
  const chatId = asStr(senderData.chatId);
  if (!chatId) return null;
  const recipientPhoneLocal = chatIdToLocalPhone(chatId);
  if (!recipientPhoneLocal) return null; // groups / unparseable → skip

  const messageData = asObj(body.messageData);
  const typeMessage = asStr(messageData.typeMessage) ?? '';
  const textMessageData = asObj(messageData.textMessageData);
  const extendedTextMessageData = asObj(messageData.extendedTextMessageData);
  const fileMessageData = asObj(messageData.fileMessageData);

  const classified = classifyIncoming(typeMessage, {
    text: asStr(textMessageData.textMessage) ?? asStr(extendedTextMessageData.text),
    downloadUrl: asStr(fileMessageData.downloadUrl),
  });
  if (!classified) return null;

  return {
    externalMessageId,
    chatId,
    recipientPhoneLocal,
    messageType: classified.messageType,
    content: classified.content,
    timestamp: asNum(body.timestamp),
  };
}

/**
 * Parse one item from the lastIncomingMessages pull response. That endpoint
 * returns a flat array where the message fields are inlined on the item (not
 * nested under messageData), so it needs its own adapter to the shared shape.
 */
export function parseLastIncomingItem(item: unknown): ParsedIncoming | null {
  const it = asObj(item);

  const externalMessageId = asStr(it.idMessage);
  if (!externalMessageId) return null;

  const chatId = asStr(it.chatId) ?? asStr(asObj(it.senderData).chatId);
  if (!chatId) return null;
  const senderPhoneLocal = chatIdToLocalPhone(chatId);
  if (!senderPhoneLocal) return null;

  const typeMessage = asStr(it.typeMessage) ?? '';
  const extended = asObj(it.extendedTextMessage);
  const classified = classifyIncoming(typeMessage, {
    text: asStr(it.textMessage) ?? asStr(extended.text),
    downloadUrl: asStr(it.downloadUrl),
  });
  if (!classified) return null;

  return {
    externalMessageId,
    chatId,
    senderPhoneLocal,
    messageType: classified.messageType,
    content: classified.content,
    timestamp: asNum(it.timestamp),
  };
}

interface SendArgs {
  instanceId: string;
  token: string;
  chatId: string;
  message: string;
}

/** Parse a Green API response body that *should* be JSON but may be HTML/plain
 *  text on gateway errors. Returns the parsed object or null. */
function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Sends a text message via Green API.
 *   POST waInstance{id}/sendMessage/{token}  body: { chatId, message }
 * Returns the idMessage on success; throws WhatsAppError otherwise.
 */
export async function sendWhatsAppMessage(args: SendArgs): Promise<{ idMessage: string }> {
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/sendMessage/${args.token}`;

  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: args.chatId, message: args.message }),
    });
    raw = await res.text();
  } catch (err) {
    throw new WhatsAppError(`החיבור ל-Green API נכשל: ${(err as Error).message}`);
  }

  const parsed = safeJson(raw);

  if (!res.ok) {
    // Green API often returns plain text / HTML on errors — surface a snippet.
    const detail =
      (parsed && (parsed.invokeStatus || parsed.message)) ||
      raw.slice(0, 200).replace(/\s+/g, ' ').trim() ||
      `HTTP ${res.status}`;
    throw new WhatsAppError(`Green API שגיאה (${res.status}): ${detail}`);
  }

  if (!parsed) {
    throw new WhatsAppError('Green API החזיר תגובה לא צפויה (לא JSON)');
  }

  const idMessage = typeof parsed.idMessage === 'string' ? parsed.idMessage : '';
  if (!idMessage) {
    throw new WhatsAppError('Green API לא החזיר idMessage');
  }

  return { idMessage };
}

interface SendFileArgs {
  instanceId: string;
  token: string;
  chatId: string;
  /** Publicly reachable file URL. */
  urlFile: string;
  /** Filename shown to the recipient. */
  fileName: string;
  /** Optional caption (text under the media). */
  caption?: string;
}

/**
 * Sends a media message by URL via Green API.
 *   POST waInstance{id}/sendFileByUrl/{token}  body: { chatId, urlFile, fileName, caption? }
 * Returns the idMessage on success; throws WhatsAppError otherwise.
 */
export async function sendWhatsAppFileByUrl(args: SendFileArgs): Promise<{ idMessage: string }> {
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/sendFileByUrl/${args.token}`;

  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: args.chatId,
        urlFile: args.urlFile,
        fileName: args.fileName,
        ...(args.caption ? { caption: args.caption } : {}),
      }),
    });
    raw = await res.text();
  } catch (err) {
    throw new WhatsAppError(`החיבור ל-Green API נכשל: ${(err as Error).message}`);
  }

  const parsed = safeJson(raw);
  if (!res.ok) {
    const detail =
      (parsed && (parsed.invokeStatus || parsed.message)) ||
      raw.slice(0, 200).replace(/\s+/g, ' ').trim() ||
      `HTTP ${res.status}`;
    throw new WhatsAppError(`Green API שגיאה (${res.status}): ${detail}`);
  }
  const idMessage = parsed && typeof parsed.idMessage === 'string' ? parsed.idMessage : '';
  if (!idMessage) {
    throw new WhatsAppError('Green API לא החזיר idMessage');
  }
  return { idMessage };
}

interface ProbeArgs {
  instanceId: string;
  token: string;
}

/**
 * Connection probe: GET waInstance{id}/getStateInstance/{token}.
 * Returns the instance state ("authorized", "notAuthorized", ...).
 * Used by the Settings "test connection" button.
 */
export async function getInstanceState(args: ProbeArgs): Promise<{ stateInstance: string }> {
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/getStateInstance/${args.token}`;

  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, { method: 'GET' });
    raw = await res.text();
  } catch (err) {
    throw new WhatsAppError(`החיבור ל-Green API נכשל: ${(err as Error).message}`);
  }

  const parsed = safeJson(raw);

  if (!res.ok) {
    const detail =
      (parsed && (parsed.invokeStatus || parsed.message)) ||
      raw.slice(0, 200).replace(/\s+/g, ' ').trim() ||
      `HTTP ${res.status}`;
    throw new WhatsAppError(`Green API שגיאה (${res.status}): ${detail}`);
  }

  const stateInstance = parsed && typeof parsed.stateInstance === 'string'
    ? parsed.stateInstance
    : '';
  if (!stateInstance) {
    throw new WhatsAppError('Green API לא החזיר stateInstance');
  }

  return { stateInstance };
}

// ─────────────────────────────────────────────────────────────────────
// Inbound network client (phase 2): pull + webhook registration.
// Like the senders above, these take explicit instanceId/token and never import
// a secret, so they're safe in this non-`server-only` module.
// ─────────────────────────────────────────────────────────────────────

/** Shared GET → text → JSON wrapper that surfaces Green API gateway errors. */
async function greenApiGet(url: string): Promise<Record<string, unknown> | unknown[]> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, { method: 'GET' });
    raw = await res.text();
  } catch (err) {
    throw new WhatsAppError(`החיבור ל-Green API נכשל: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const parsed = safeJson(raw);
    const detail =
      (parsed && (parsed.invokeStatus || parsed.message)) ||
      raw.slice(0, 200).replace(/\s+/g, ' ').trim() ||
      `HTTP ${res.status}`;
    throw new WhatsAppError(`Green API שגיאה (${res.status}): ${detail}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown> | unknown[];
  } catch {
    throw new WhatsAppError('Green API החזיר תגובה לא צפויה (לא JSON)');
  }
}

/**
 * GET waInstance{id}/lastIncomingMessages/{token}?minutes=N — the pull fallback.
 * Returns the raw array of incoming-message items (each parsed via
 * parseLastIncomingItem). Default window 1440 minutes (24h).
 */
export async function getIncomingMessages(
  args: ProbeArgs & { minutes?: number },
): Promise<unknown[]> {
  const minutes = args.minutes && args.minutes > 0 ? Math.floor(args.minutes) : 1440;
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/lastIncomingMessages/${args.token}?minutes=${minutes}`;
  const data = await greenApiGet(url);
  return Array.isArray(data) ? data : [];
}

/** GET waInstance{id}/getSettings/{token} — current instance settings (webhook). */
export async function getWebhookSettings(args: ProbeArgs): Promise<Record<string, unknown>> {
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/getSettings/${args.token}`;
  const data = await greenApiGet(url);
  return Array.isArray(data) ? {} : data;
}

/**
 * POST waInstance{id}/setSettings/{token} — register our webhook.
 * Enables the full notification set the inbox needs: incoming messages, outgoing
 * messages (sent from the API or the phone) and outgoing delivery status
 * (delivered/read). webhookUrlToken is optional — the canonical webhook
 * authenticates with a `?secret=` query param baked into webhookUrl, so the
 * bearer token is defence-in-depth only. The instance reboots for a few seconds
 * afterwards (Green API behaviour).
 */
export async function setWebhookSettings(
  args: ProbeArgs & { webhookUrl: string; webhookToken?: string },
): Promise<void> {
  const url = `${GREEN_API_BASE}/waInstance${args.instanceId}/setSettings/${args.token}`;
  const payload: Record<string, string> = {
    webhookUrl: args.webhookUrl,
    incomingWebhook: 'yes',
    outgoingWebhook: 'yes',
    outgoingMessageWebhook: 'yes',
    outgoingAPIMessageWebhook: 'yes',
    stateWebhook: 'no',
  };
  if (args.webhookToken) payload.webhookUrlToken = args.webhookToken;

  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    raw = await res.text();
  } catch (err) {
    throw new WhatsAppError(`החיבור ל-Green API נכשל: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const parsed = safeJson(raw);
    const detail =
      (parsed && (parsed.invokeStatus || parsed.message)) ||
      raw.slice(0, 200).replace(/\s+/g, ' ').trim() ||
      `HTTP ${res.status}`;
    throw new WhatsAppError(`Green API שגיאה (${res.status}): ${detail}`);
  }
}
