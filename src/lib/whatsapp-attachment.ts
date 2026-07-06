// Shared rules for a single WhatsApp message attachment sent from the debtor
// card. Used by BOTH the client (WhatsAppSendForm — pre-flight validation) and
// the server (/api/whatsapp/send — authoritative validation) so the two can
// never disagree on what's allowed. Not `server-only`: intentionally isomorphic.

/** 10MB cap. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Allowed extensions (the authoritative check — browsers send flaky MIME for
 *  docx/xlsx, so extension is the reliable signal). */
export const ATTACHMENT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'docx', 'xlsx'] as const;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** Lower-case extension without the dot, or '' when none. */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** image (jpg/png/webp) → 'image', everything else allowed → 'document'. Keyed
 *  on the extension, mirroring chat-send-file's image/document split. */
export function attachmentMessageType(name: string): 'image' | 'document' {
  return IMAGE_EXTS.has(extOf(name)) ? 'image' : 'document';
}

/** Validate a file-ish ({ name, size }). Returns a Hebrew error string, or null
 *  when the file is acceptable. */
export function validateAttachment(file: { name: string; size: number }): string | null {
  const ext = extOf(file.name);
  if (!ext || !(ATTACHMENT_EXTS as readonly string[]).includes(ext)) {
    return 'סוג הקובץ אינו נתמך. מותר: JPG, PNG, WEBP, PDF, DOCX, XLSX';
  }
  if (file.size <= 0) {
    return 'הקובץ ריק';
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return 'הקובץ גדול מדי (מקסימום 10MB)';
  }
  return null;
}
