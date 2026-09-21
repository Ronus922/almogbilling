// Finance module ("שקיפות כספית") — the single source of truth for the receipt
// attachment policy and the module's fixed vocabulary. Isomorphic on purpose:
// the entry sheet pre-checks a file with it and the upload route enforces it
// (the server is authoritative), exactly like whatsappAttachments.ts.
import { formatMb } from '@/lib/constants/whatsappAttachments';

const MB = 1024 * 1024;

/** The PRIVATE bucket of receipts/invoices. The browser reaches a file only
 *  through /api/files/finance-receipts/<key> (session + finance:view). */
export const FINANCE_RECEIPTS_BUCKET = 'finance-receipts';

export const FINANCE_RECEIPT_LIMITS = {
  /** Files per entry. */
  maxFiles: 5,
  /** Per file — the self-hosted Storage FILE_SIZE_LIMIT (50 MB) is the binding cap. */
  maxBytes: 50 * MB,
} as const;

/** Extension → canonical MIME + what browsers are known to report for it. The
 *  extension is the authoritative signal; the reported MIME only has to be
 *  consistent with it (or empty / octet-stream). */
const EXT_MIME: Record<string, { canonical: string; accepted: readonly string[] }> = {
  pdf:  { canonical: 'application/pdf', accepted: ['application/pdf'] },
  jpg:  { canonical: 'image/jpeg', accepted: ['image/jpeg', 'image/pjpeg'] },
  jpeg: { canonical: 'image/jpeg', accepted: ['image/jpeg', 'image/pjpeg'] },
  png:  { canonical: 'image/png',  accepted: ['image/png'] },
};

/** `accept` attribute for the file input. */
export const FINANCE_RECEIPT_ACCEPT = Object.keys(EXT_MIME).map((e) => `.${e}`).join(',');
export const FINANCE_RECEIPT_TYPES_LABEL = 'PDF, JPG, PNG';

export function receiptHelpText(maxFiles: number = FINANCE_RECEIPT_LIMITS.maxFiles): string {
  return `${FINANCE_RECEIPT_TYPES_LABEL} · עד ${formatMb(FINANCE_RECEIPT_LIMITS.maxBytes)} לקובץ · עד ${maxFiles} קבצים`;
}

/** Lower-case extension without the dot, or '' when none. */
export function receiptExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Canonical MIME for an allowed extension (what is stored), or null. */
export function receiptCanonicalMime(ext: string): string | null {
  return EXT_MIME[ext]?.canonical ?? null;
}

export interface ReceiptCandidate {
  name: string;
  size: number;
  /** Browser-reported MIME ('' when unknown). */
  type?: string;
}

/** Validate ONE file (type / MIME / size). Hebrew error, or null when fine.
 *  Pure — same result on client and server. */
export function validateFinanceReceipt(file: ReceiptCandidate): string | null {
  const ext = receiptExt(file.name);
  if (!ext || !EXT_MIME[ext]) {
    return `סוג הקובץ אינו נתמך («${file.name}»). מותר: ${FINANCE_RECEIPT_TYPES_LABEL}`;
  }
  const mime = (file.type ?? '').trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && !EXT_MIME[ext].accepted.includes(mime)) {
    return `תוכן הקובץ «${file.name}» אינו תואם לסיומת ${ext.toUpperCase()}`;
  }
  if (file.size <= 0) return `הקובץ «${file.name}» ריק`;
  if (file.size > FINANCE_RECEIPT_LIMITS.maxBytes) {
    return `קובץ עד ${formatMb(FINANCE_RECEIPT_LIMITS.maxBytes)} — «${file.name}» שוקל ${formatMb(file.size)}`;
  }
  return null;
}

/** Validate the entry-level rule (count) for adding `next` on top of `existing`. */
export function validateFinanceReceiptSet(
  existing: ReadonlyArray<{ size: number }>,
  next: ReadonlyArray<{ size: number }> = [],
  maxFiles: number = FINANCE_RECEIPT_LIMITS.maxFiles,
): string | null {
  if (existing.length + next.length > maxFiles) return `ניתן לצרף עד ${maxFiles} קבצים`;
  return null;
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

export type FinKind = 'income' | 'expense';
export const FIN_KINDS: readonly FinKind[] = ['income', 'expense'] as const;
export const FIN_KIND_LABEL: Record<FinKind, string> = { income: 'הכנסה', expense: 'הוצאה' };
export const FIN_KIND_LABEL_PLURAL: Record<FinKind, string> = { income: 'הכנסות', expense: 'הוצאות' };

export type FinSection = 'operating' | 'renovation_fund';
export const FIN_SECTIONS: readonly FinSection[] = ['operating', 'renovation_fund'] as const;
export const FIN_SECTION_LABEL: Record<FinSection, string> = { operating: 'שוטף', renovation_fund: 'קרן שיפוצים' };

export type FinSource = 'manual' | 'ledger_import' | 'scan';
export type DriveStatus = 'pending' | 'done' | 'failed';

// ── Google Drive backup ───────────────────────────────────────────────────────

/** The account meant to hold the backups; the settings screen warns when
 *  another one was connected. */
export const FINANCE_DRIVE_ACCOUNT = 'lahav.yeadim@gmail.com';
/** Root folder in that Drive; year / month folders are created under it. */
export const FINANCE_DRIVE_ROOT_FOLDER = 'ALMOG — קבלות';
/** A document is retried until this many attempts failed. */
export const FINANCE_DRIVE_MAX_ATTEMPTS = 5;
