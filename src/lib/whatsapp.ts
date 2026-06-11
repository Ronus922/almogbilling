import 'server-only';

// Green API (green-api.com) outbound client + Israeli phone normalisation.
// Phase 1: text messages only. No webhooks / inbound handling yet.

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
