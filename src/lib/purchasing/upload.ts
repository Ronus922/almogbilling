import 'server-only';
import {
  bytesMatchExt, purchasingFileExt, purchasingFileMime, validatePurchasingFile,
} from './files';
import { sniffImage, validateBrandImage } from './model';

export interface ReadUpload {
  bytes: Buffer;
  mime: string;
  name: string;
}

/** Reads a multipart `File` and decides: name/size/declared type first (cheap),
 *  then the BYTES against the extension (a renamed file is refused). Returns a
 *  Hebrew reason on refusal. Used for staff attachments and supplier uploads
 *  alike; `maxBytes` is the only difference. */
export async function readAttachment(file: File, maxBytes: number): Promise<ReadUpload | { error: string }> {
  const reason = validatePurchasingFile({ name: file.name, size: file.size, type: file.type }, maxBytes);
  if (reason) return { error: reason };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { error: 'הקובץ גדול מדי' };
  if (!bytesMatchExt(purchasingFileExt(file.name), bytes)) return { error: 'תוכן הקובץ אינו תואם לסוג שלו' };
  return { bytes, mime: purchasingFileMime(file.name) as string, name: file.name };
}

/** The letterhead images: PNG / JPEG only, magic bytes checked. */
export async function readBrandImage(file: File): Promise<ReadUpload | { error: string }> {
  const reason = validateBrandImage({ name: file.name, size: file.size, type: file.type });
  if (reason) return { error: reason };
  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return { error: 'הקובץ אינו תמונת PNG או JPG תקינה' };
  return { bytes, mime: kind === 'png' ? 'image/png' : 'image/jpeg', name: file.name };
}

export const isUploadError = (r: ReadUpload | { error: string }): r is { error: string } => 'error' in r;
