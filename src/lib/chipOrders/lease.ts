import { canonicalMime, formatMb, mimeMatchesExt } from '@/lib/constants/whatsappAttachments';
import { bytesMatchExt, purchasingFileExt } from '@/lib/purchasing/files';
import { CHIP_ORDER_LIMITS, LEASE_FILE_EXTS } from './model';

// The lease / management agreement of a tenant or an operator: a PDF or a
// photo, up to 10MB. Isomorphic — the page pre-checks with leaseFileProblem(),
// the route decides with readLease() (the bytes must match the extension, the
// same magic-byte table purchasing uses, so a renamed file is refused).

export function leaseFileProblem(file: { name: string; size: number; type?: string }): string | null {
  const ext = purchasingFileExt(file.name);
  if (!ext || !(LEASE_FILE_EXTS as readonly string[]).includes(ext)) return 'החוזה חייב להיות PDF או תמונה';
  if (!mimeMatchesExt(ext, file.type ?? '')) return `תוכן הקובץ אינו תואם לסיומת ${ext.toUpperCase()}`;
  if (file.size <= 0) return 'הקובץ ריק';
  if (file.size > CHIP_ORDER_LIMITS.leaseFileBytes) return `הקובץ גדול מ-${formatMb(CHIP_ORDER_LIMITS.leaseFileBytes)}`;
  return null;
}

export interface ReadLease {
  bytes: Buffer;
  mime: string;
  name: string;
}

export async function readLease(file: File): Promise<ReadLease | { error: string }> {
  const problem = leaseFileProblem({ name: file.name, size: file.size, type: file.type });
  if (problem) return { error: problem };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > CHIP_ORDER_LIMITS.leaseFileBytes) return { error: 'הקובץ גדול מדי' };
  const ext = purchasingFileExt(file.name);
  if (!bytesMatchExt(ext, bytes)) return { error: 'תוכן הקובץ אינו תואם לסוג שלו' };
  return { bytes, mime: canonicalMime(ext) ?? 'application/octet-stream', name: file.name.slice(0, 200) };
}

export const isLeaseError = (r: ReadLease | { error: string }): r is { error: string } => 'error' in r;
