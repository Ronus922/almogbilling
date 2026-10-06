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
  /** Whether residents see the hand-entered month-end bank balance (28/09/2026). */
  show_bank_balance_to_residents: boolean;
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

// ── Month publishing ──────────────────────────────────────────────────────────

/** One row of finance_month_status. A month with no row is unpublished. */
export interface FinMonthStatus {
  year: number;
  month: number;
  published: boolean;
  /** Time of the LAST toggle, either direction. */
  published_at: string | null;
  published_by: string | null;
  /** Bank balance at the end of the month, entered by hand; null = not entered. */
  bank_balance: number | null;
  bank_balance_updated_at: string | null;
  bank_balance_updated_by: string | null;
}

// ── Renovation fund ───────────────────────────────────────────────────────────

export interface RenovationFundSettings {
  target_amount: number;
  updated_at: string;
}

/** A fund expense category ("מטרה") with its all-time total (0 when unused). */
export interface FundPurposeTotal {
  category_id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  total: number;
}

/** A fund line as the ledger shows it: the entry + whether its month is published. */
export interface FundLedgerEntry extends FinEntry {
  published: boolean;
}

/** What the fund ledger TABLE needs of a line — the resident-safe subset.
 *  FundLedgerEntry satisfies it; a resident row carries nothing more. */
export interface FundLedgerRow {
  /** Entry id for the admin (edit / delete); absent on a resident row. */
  id?: string;
  kind: FinKind;
  category_name: string;
  description: string;
  amount: number;
  /** 'YYYY-MM-DD' or null (incomes). */
  payment_date: string | null;
  /** 'YYYY-MM-01' */
  period_month: string;
  published: boolean;
}

/** The fund KPIs as a resident gets them: published months only, ledger rows
 *  stripped to FundLedgerRow (no id, supplier, invoice, note or files). */
export interface ResidentFundKpis extends Omit<RenovationFundKpis, 'entries'> {
  entries: FundLedgerRow[];
}

export interface RenovationFundKpis {
  target_amount: number;
  /** Sum of every fund income (all months). */
  collected: number;
  /** Sum of every fund expense (all months). */
  spent: number;
  balance: number;
  /** collected / target, 0–100 (0 when there is no target). Not capped. */
  pct: number;
  by_purpose: FundPurposeTotal[];
  /** Newest first. */
  entries: FundLedgerEntry[];
}

// ── Period report (quarter / half / year of the operating budget) ────────────

export interface PeriodReportMonth {
  /** 'YYYY-MM' */
  month: string;
  published: boolean;
  /** Whether this month's lines are in the sums (false only with publishedOnly). */
  included: boolean;
}

export interface PeriodReportCategory {
  category_id: string;
  kind: FinKind;
  name: string;
  sort_order: number;
  is_hot_water: boolean;
  total: number;
  /** total / number of included months. */
  average: number;
  /** 'YYYY-MM' → sum (only months with lines). */
  by_month: Record<string, number>;
}

export interface PeriodReport {
  from: string;
  to: string;
  months: PeriodReportMonth[];
  income: PeriodReportCategory[];
  expense: PeriodReportCategory[];
  totals: { income: number; expense: number; surplus: number };
}

// ── Resident (portal) shapes — only what a resident may see ───────────────────

/** A receipt of a resident-visible line, as the portal's document button
 *  opens it: the authenticated proxy URL (/api/files/finance-receipts/…) and
 *  the readable name. Present ONLY while "הצג מסמכים לדיירים" is on —
 *  portal.ts never attaches it otherwise, so the key cannot reach a browser. */
export interface ResidentDocument {
  url: string;
  name: string;
}

export interface ResidentEntry {
  kind: FinKind;
  section: FinSection;
  /** The category's id — what the transactions tab's category row asks its
   *  monthly trend by. A category, never a line: entry ids stay inside portal.ts. */
  category_id: string;
  category_name: string;
  description: string;
  amount: number;
  /** 'YYYY-MM-DD' or null (incomes). */
  payment_date: string | null;
  /** 'YYYY-MM-01' — the month the line is filed to (an income has no other date). */
  period_month: string;
  /** Receipts — only when show_documents_to_residents is on; absent otherwise. */
  documents?: ResidentDocument[];
}

export interface ResidentMonthSection {
  income: ResidentEntry[];
  expense: ResidentEntry[];
  totals: { income: number; expense: number; diff: number };
}

export interface ResidentMonthData {
  year: number;
  month: number;
  operating: ResidentMonthSection;
  fund: ResidentMonthSection;
  /** The month-end bank balance — present ONLY while the "הצג יתרת בנק
   *  לדיירים" switch is on and a value was entered; absent otherwise. */
  bank_balance?: number;
}

/** One calendar month of the transactions tab's period: whether residents get
 *  it (published), and its operating totals — a month they do not get carries
 *  zeros and contributes nothing, so a hidden month cannot show up as a column
 *  or inside a total. */
export interface ResidentPeriodMonth {
  /** 'YYYY-MM' */
  month: string;
  included: boolean;
  income: number;
  expense: number;
}

/** Everything the transactions tab shows for the selected period — one month,
 *  a quarter, a half or a year (the period picker's four levels). The lines
 *  and the totals cover the INCLUDED months only; `months` lists every
 *  calendar month of the period up to the current one, so the screen can say
 *  "N of M months" and draw a column per month residents actually get. */
export interface ResidentPeriodData {
  /** 'YYYY-MM', inclusive. */
  from: string;
  to: string;
  /** Oldest first. */
  months: ResidentPeriodMonth[];
  operating: ResidentMonthSection;
  /** The period's closing bank balance: the newest included month that has a
   *  value. Absent while the "הצג יתרת בנק לדיירים" switch is off, or when no
   *  included month carries one. */
  bank_balance?: number;
  /** 'YYYY-MM' of the month that balance belongs to. */
  bank_balance_month?: string;
}

/** The building's bank balance as the overview shows it: the newest published
 *  month that has a value, and the published month right before it when that
 *  one has a value too (for the "מול החודש הקודם" line). Only while the switch
 *  is on — portal.ts never builds it otherwise. */
export interface ResidentBankBalance {
  /** 'YYYY-MM' */
  month: string;
  value: number;
  previous: { month: string; value: number } | null;
}

// ── Resident overview (the portal's "סקירה" tab) ─────────────────────────────

/** One published month of the overview window with its operating totals. */
export interface ResidentOverviewMonth {
  /** 'YYYY-MM' */
  month: string;
  income: number;
  expense: number;
}

/** An operating expense category over the window — 'YYYY-MM' → sum, so the
 *  screen can re-total it for a shorter window without another request. */
export interface ResidentOverviewCategory {
  name: string;
  by_month: Record<string, number>;
}

/** Everything the overview tab shows, published months only (portal.ts):
 *  the last `months.length` published months up to the newest one, the expense
 *  categories over that window and the newest operating lines. */
export interface ResidentOverview {
  /** Newest published month, 'YYYY-MM'. */
  latest: string;
  /** Published months inside the window, OLDEST first. */
  months: ResidentOverviewMonth[];
  expense_categories: ResidentOverviewCategory[];
  /** Newest operating lines across published months, newest first. */
  recent: ResidentEntry[];
  /** Absent while the bank-balance switch is off or nothing was entered. */
  bank_balance?: ResidentBankBalance;
}

/** One column of the transactions tab's category trend: a published month and
 *  the category's sum in it, in WHOLE shekels (the exact sum, rounded once) —
 *  0 when the month has no line of that category. */
export interface ResidentCategoryMonth {
  /** 'YYYY-MM' */
  month: string;
  total: number;
}
