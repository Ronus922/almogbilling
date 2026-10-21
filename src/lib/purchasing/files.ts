// Purchasing — what may be attached to a request / quote, and how it is
// checked. Isomorphic: the panel pre-checks, the routes decide (the server is
// authoritative). The extension table and the MIME quirks (Office as ZIP on
// Windows Chrome) are the reminders' — one policy, not a new list.
import { canonicalMime, formatMb, mimeMatchesExt } from '@/lib/constants/whatsappAttachments';

const EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx'] as const;

export const PURCHASING_FILE_ACCEPT = EXTS.map((e) => `.${e}`).join(',');
export const PURCHASING_FILE_TYPES_LABEL = 'PDF, תמונות, Word, Excel';

export function purchasingFileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Canonical MIME stored for an allowed extension, or null. */
export function purchasingFileMime(name: string): string | null {
  const ext = purchasingFileExt(name);
  return (EXTS as readonly string[]).includes(ext) ? canonicalMime(ext) : null;
}

/** One file, before its bytes are read: type, declared MIME, size. A short
 *  Hebrew reason, or null when fine. */
export function validatePurchasingFile(
  file: { name: string; size: number; type?: string },
  maxBytes: number,
): string | null {
  const ext = purchasingFileExt(file.name);
  if (!ext || !(EXTS as readonly string[]).includes(ext)) return 'סוג הקובץ אינו נתמך';
  if (!mimeMatchesExt(ext, file.type ?? '')) return `תוכן הקובץ אינו תואם לסיומת ${ext.toUpperCase()}`;
  if (file.size <= 0) return 'הקובץ ריק';
  if (file.size > maxBytes) return `הקובץ גדול מ-${formatMb(maxBytes)}`;
  return null;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Server-side: do the BYTES match the declared extension? A renamed .exe or an
 *  HTML page called .pdf is refused here, whatever its Content-Type claims. */
export function bytesMatchExt(ext: string, b: Uint8Array): boolean {
  if (b.length < 12) return false;
  switch (ext) {
    case 'pdf': return startsWith(b, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case 'png': return startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
    case 'jpg':
    case 'jpeg': return startsWith(b, [0xff, 0xd8, 0xff]);
    case 'webp': return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
    case 'docx':
    case 'xlsx': return startsWith(b, [0x50, 0x4b, 0x03, 0x04]); // ZIP container
    case 'doc':
    case 'xls': return startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]); // OLE2
    default: return false;
  }
}
