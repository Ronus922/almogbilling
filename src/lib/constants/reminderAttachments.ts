// Reminders module (/user-reminders) — the single source of truth for what may
// be attached to a reminder and how big it may be. Isomorphic on purpose: the
// panel pre-checks a file with it and the upload route enforces it (the server
// is authoritative), exactly like whatsappAttachments.ts / finance.ts.
//
// The numbers are the product rule of the reminder panel (ref/Reminder Dialog,
// 05/10/2026): "PDF, תמונות, Word, Excel · עד 10 קבצים, 20MB לקובץ". 20 MB is
// under the 50 MB FILE_SIZE_LIMIT of the self-hosted Storage, so it binds.
import { canonicalMime, formatMb, mimeMatchesExt } from '@/lib/constants/whatsappAttachments';

const MB = 1024 * 1024;

export const REMINDER_ATTACHMENT_LIMITS = {
  /** Files per reminder. */
  maxFiles: 10,
  /** Per file. */
  maxBytes: 20 * MB,
} as const;

/** Allowed extensions — PDF, images, Word, Excel. MIME rules (and the
 *  Office-as-ZIP quirk of Chrome on Windows) come from the WhatsApp table. */
const EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx'] as const;

/** `accept` attribute for the file input. */
export const REMINDER_ATTACHMENT_ACCEPT = EXTS.map((e) => `.${e}`).join(',');
export const REMINDER_ATTACHMENT_TYPES_LABEL = 'PDF, תמונות, Word, Excel';

/** The dropzone hint of an empty list (the ref's wording). */
export function reminderAttachmentHelpText(): string {
  return `${REMINDER_ATTACHMENT_TYPES_LABEL} · עד ${REMINDER_ATTACHMENT_LIMITS.maxFiles} קבצים, ${formatMb(REMINDER_ATTACHMENT_LIMITS.maxBytes)} לקובץ`;
}

/** Lower-case extension without the dot, or '' when none. */
export function reminderAttachmentExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Canonical MIME for an allowed extension (what is stored), or null. */
export function reminderAttachmentMime(name: string): string | null {
  const ext = reminderAttachmentExt(name);
  return (EXTS as readonly string[]).includes(ext) ? canonicalMime(ext) : null;
}

export interface ReminderAttachmentCandidate {
  name: string;
  size: number;
  /** Browser-reported MIME ('' when unknown). */
  type?: string;
}

/** Validate ONE file (type / MIME / size). A short Hebrew reason — the panel
 *  shows it on the file's row as "<reason> · לא הועלה" — or null when fine.
 *  Pure — same result on client and server. */
export function validateReminderAttachment(file: ReminderAttachmentCandidate): string | null {
  const ext = reminderAttachmentExt(file.name);
  if (!ext || !(EXTS as readonly string[]).includes(ext)) return 'סוג הקובץ אינו נתמך';
  if (!mimeMatchesExt(ext, file.type ?? '')) return `תוכן הקובץ אינו תואם לסיומת ${ext.toUpperCase()}`;
  if (file.size <= 0) return 'הקובץ ריק';
  if (file.size > REMINDER_ATTACHMENT_LIMITS.maxBytes) {
    return `הקובץ גדול מ-${formatMb(REMINDER_ATTACHMENT_LIMITS.maxBytes)}`;
  }
  return null;
}

/** Validate the reminder-level rule (count) for adding `next` on top of `existing`. */
export function validateReminderAttachmentSet(
  existing: ReadonlyArray<{ size: number }>,
  next: ReadonlyArray<{ size: number }> = [],
  maxFiles: number = REMINDER_ATTACHMENT_LIMITS.maxFiles,
): string | null {
  if (existing.length + next.length > maxFiles) return `ניתן לצרף עד ${REMINDER_ATTACHMENT_LIMITS.maxFiles} קבצים`;
  return null;
}
