// Durable WhatsApp delivery queue — shared types (no imports, safe in the Next
// server, the standalone worker, and tests).

export type CampaignStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'failed';

export type RecipientStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Error taxonomy — decides retry vs. give-up (see errors.ts). */
export type ErrorClass =
  | 'retryable'      // transient transport error → retry
  | 'rate_limited'   // provider 429 → retry (paced)
  | 'auth'           // credentials/config broken → do NOT retry (needs a human)
  | 'invalid_phone'  // permanent — bad recipient
  | 'invalid_payload'// permanent — bad message
  | 'permanent'      // provider rejected permanently
  | 'indeterminate'; // lease expired AFTER a send was attempted — maybe delivered

export interface Campaign {
  id: string;
  type: 'broadcast';
  status: CampaignStatus;
  name: string;
  body: string;
  /** Snapshot of the chosen template's name (null = free text). Immutable — stays
   *  correct even after the source template is edited or deleted. */
  template_name: string | null;
  audience: unknown;
  instance_id: string | null;
  created_by: string | null;
  total_count: number;
  pending_count: number;
  processing_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  cancelled_count: number;
  rate_per_min: number;
  dry_run: boolean;
  client_token: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  cancelled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Recipient {
  id: string;
  campaign_id: string;
  debtor_id: string | null;
  phone_intl: string;
  chat_id: string;
  payload: string;
  status: RecipientStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  worker_id: string | null;
  processing_started_at: string | null;
  lease_expires_at: string | null;
  send_attempted_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  /** Delivery lifecycle of an already-sent message (Green API webhook). NOT a
   *  recipient state — the row stays 'sent'; these only enrich the log. */
  delivered_at: string | null;
  read_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  error_class: ErrorClass | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

/** One recipient as supplied to createCampaign (identity + message snapshot). */
export interface RecipientInput {
  debtorId: string | null;
  phoneIntl: string;   // '9725XXXXXXXX'
  payload: string;     // fully interpolated message
}

// ── View models (query joins that enrich the raw rows for the UI) ─────────────

/** A campaign row for the history list — joins the creator's display name. */
export interface CampaignListItem extends Campaign {
  created_by_name: string | null;
}

/** The details header — the list row plus delivery-lifecycle counts (derived from
 *  recipient timestamps; NOT separate recipients, so they never break the counter
 *  invariant). */
export interface CampaignDetail extends CampaignListItem {
  delivered_count: number;
  read_count: number;
}

/** A recipient row for the delivery log — joins the debtor's name + apartment and
 *  carries a phone masked in the query (raw phone_intl is never sent to the UI). */
export interface RecipientLogRow {
  id: string;
  status: RecipientStatus;
  /** Masked local phone, e.g. '050-•••-••34'. */
  phone_masked: string;
  debtor_name: string | null;
  apartment_number: string | null;
  attempt_count: number;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  error_class: ErrorClass | null;
  created_at: string;
}

/** A page of recipient-log rows. */
export interface RecipientLogPage {
  rows: RecipientLogRow[];
  total: number;
}

/** A page of campaign-history rows. */
export interface CampaignListPage {
  rows: CampaignListItem[];
  total: number;
}

/** Filters accepted by the history list. */
export interface CampaignListFilters {
  status?: CampaignStatus;
  /** Case-insensitive substring match on the campaign name. */
  q?: string;
  /** Inclusive ISO date bounds on created_at. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
