// Shapes the purchasing screens read from /api/purchasing/* — type-only imports
// from the server modules (erased at build), so client and server cannot drift.
import type {
  DispatchRow, DocumentListItem, DocumentRow, FileRow, LineRow, QuoteRow, RecipientRow, SupplierBrief,
} from '@/lib/db/purchasing';
import type { DocType } from '@/lib/purchasing/model';

export type { DocType, DocumentListItem, SupplierBrief, LineRow };

export type FileView = FileRow & { url: string };

export interface RecipientView extends RecipientRow { link: string }
export type QuoteView = Omit<QuoteRow, 'files'> & { files: FileView[] };

export interface DocumentDetail {
  document: DocumentRow;
  lines: LineRow[];
  files: FileView[];
  dispatches: DispatchRow[];
  supplier: SupplierBrief | null;
  recipients?: RecipientView[];
  quotes?: QuoteView[];
}

export interface SequenceState { rfq: number | null; po: number | null }

/** A purchase order opened from a winning quote: the screen pre-fills these. */
export interface PoPrefill {
  /** null = the winner is the request's hand-typed supplier (`manual` carries its details). */
  supplier_id: string | null;
  manual: { name: string; phone: string; email: string; address: string } | null;
  source_rfq_id: string;
  source_rfq_number: number;
  title: string;
  /** unit_price null = the winning offer was a lump sum: the user prices the lines. */
  lines: Array<{ description: string; quantity: number; unit_price: number | null }>;
}
