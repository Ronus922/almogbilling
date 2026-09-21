// Client-safe types of the finance module ("שקיפות כספית"). The DB modules
// under src/lib/db/finance/* are `server-only`; components import the shapes
// from here so the boundary stays clean.
import type { DriveStatus, FinKind, FinSection, FinSource } from '@/lib/constants/finance';

export interface FinCategory {
  id: string;
  kind: FinKind;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_hot_water: boolean;
  section: FinSection;
  created_at: string;
  /** Entries pointing at it, INCLUDING soft-deleted ones — a deleted line still
   *  references the category, so the category still cannot be deleted. */
  entries_count: number;
}

export interface FinCategoryInput {
  kind: FinKind;
  name: string;
  section: FinSection;
  is_hot_water: boolean;
  is_active: boolean;
}

/** What the screens get per receipt (+ the authenticated proxy `url`). */
export interface FinDocumentView {
  id: string;
  original_name: string;
  mime: string;
  size: number;
  url: string;
  drive_status: DriveStatus;
  drive_error: string | null;
  drive_attempts: number;
  drive_file_id: string | null;
}

export interface FinEntry {
  id: string;
  kind: FinKind;
  category_id: string;
  category_name: string;
  category_section: FinSection;
  category_is_hot_water: boolean;
  category_sort_order: number;
  /** 'YYYY-MM-01' */
  period_month: string;
  amount: number;
  description: string;
  internal_note: string;
  supplier_id: string | null;
  supplier_name: string;
  invoice_number: string;
  /** 'YYYY-MM-DD' or null (incomes). */
  payment_date: string | null;
  source: FinSource;
  created_at: string;
  updated_at: string;
  documents: FinDocumentView[];
}

export interface FinanceSettings {
  show_documents_to_residents: boolean;
  updated_at: string | null;
}

export interface DriveConnectionPublic {
  connected: boolean;
  email: string | null;
  connected_at: string | null;
}

export interface DriveBackupStats {
  pending: number;
  failed: number;
  done: number;
  /** failed AND out of attempts — only "נסה שוב" revives them. */
  exhausted: number;
}

/** The supplier roster the expense sheet searches (name / company / ח.פ. / phones). */
export interface SupplierOption {
  id: string;
  display_name: string;
  company_name: string;
  tax_id: string;
  phone: string;
  mobile: string;
}

export interface DuplicateExpense {
  id: string;
  payment_date: string | null;
  amount: number;
  supplier_name: string;
}
