import 'server-only';
import { query } from '@/lib/db';

// Fixed signature appended to the END of every outbound notification — create
// AND reminder, email AND WhatsApp. Source of truth is app_settings
// (key='notification_signature', jsonb {inviter, manager, phone}); when the row
// is absent or malformed we fall back to the hardcoded values below, so the
// signature works with zero configuration and is editable via SQL without a
// deploy. Cached in-module (short TTL) so a reminder batch does at most one read.

export interface NotificationSignature {
  inviter: string;
  manager: string;
  phone: string;
}

const FALLBACK: NotificationSignature = {
  inviter: 'בניין אלמוג חיפה',
  manager: 'רונן משולם',
  phone: '0525460546',
};

const TTL_MS = 5 * 60 * 1000;
let cache: { value: NotificationSignature; at: number } | null = null;

function pick(raw: Record<string, unknown>, key: keyof NotificationSignature): string {
  const v = raw[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : FALLBACK[key];
}

/** The signature values (settings row → fallback). Never throws. */
export async function getSignature(): Promise<NotificationSignature> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value = FALLBACK;
  try {
    const r = await query<{ value: unknown }>(
      `select value from public.app_settings where key = $1 limit 1`,
      ['notification_signature'],
    );
    const raw = r.rows[0]?.value;
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      value = { inviter: pick(obj, 'inviter'), manager: pick(obj, 'manager'), phone: pick(obj, 'phone') };
    }
  } catch (err) {
    console.error('[signature] read failed — using fallback', err);
    value = FALLBACK;
  }
  cache = { value, at: Date.now() };
  return value;
}

/** Plain-text block (3 lines, no leading blank) — used for email text + base. */
export function signaturePlainLines(sig: NotificationSignature): string {
  return `מזמין: ${sig.inviter}\nמנהל אתר: ${sig.manager}\nטלפון: ${sig.phone}`;
}

/** WhatsApp: a blank separator line then the 3 lines, appended to the message. */
export function signatureWhatsApp(sig: NotificationSignature): string {
  return `\n\n${signaturePlainLines(sig)}`;
}

/** Email: a visually separated (border-top, muted) RTL HTML block. */
export function signatureHtml(sig: NotificationSignature): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:13px;color:#64748b;line-height:1.8;text-align:right">
    מזמין: ${esc(sig.inviter)}<br/>
    מנהל אתר: ${esc(sig.manager)}<br/>
    טלפון: <span dir="ltr">${esc(sig.phone)}</span>
  </div>`;
}
