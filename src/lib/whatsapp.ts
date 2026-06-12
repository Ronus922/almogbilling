// Green API (green-api.com) outbound client + Israeli phone normalisation.
// Phase 1: text messages only. No webhooks / inbound handling yet.
//
// NOT `server-only`: parsePhoneCandidates / normalizePhone are pure helpers used
// by client components (the send panel + the debtors table) to decide validity
// and render the recipient picker. The network functions below take an explicit
// instanceId/token (no secret import), so they're never wired from the browser.

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
