import 'server-only';
import { query, queryOne } from '@/lib/db';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import { normalizeLegalContact, type LegalContact } from '@/lib/validation/legalContact';
import { env } from '@/env';
import { resolveSmtpSettings, SMTP_SETTINGS_KEY, type SmtpSettings } from '@/lib/email/smtp-core';
import { claimSmtpAuthAlertSlotWith } from '@/lib/email/smtp-auth-alert';
import {
  CHIP_ORDER_LIMITS,
  DEFAULT_CHIP_ORDER_SETTINGS,
  type ChipOrderSettings,
} from '@/lib/chipOrders/model';

export type { SmtpSettings };

const SMTP_KEY = SMTP_SETTINGS_KEY;
const BILLING_KEY = 'billing';
const LEGAL_CONTACT_KEY = 'legal_contact';

/** One upsert for every key — the value shape is per-key (see 006 / 078). */
async function upsertAppSetting(key: string, value: unknown, updatedBy: string): Promise<void> {
  await query(
    `insert into public.app_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}

interface SmtpRow {
  user: string;
  fromName: string;
  passEnc: EncryptedBlob;
}

export interface SmtpSettingsPublic {
  fromEmail: string;
  fromName: string;
  hasPassword: boolean;
}

/** Thrown when caller-supplied input is invalid. Route layer maps to HTTP 400. */
export class AppSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSettingsValidationError';
  }
}

/**
 * Resolve SMTP settings: DB row wins, env vars are fallback.
 * Throws if neither yields user+pass — caller treats as fatal.
 * (The logic lives in email/smtp-core.ts, shared with the delivery worker.)
 */
export async function getSmtpSettings(): Promise<SmtpSettings> {
  return resolveSmtpSettings({ query }, decrypt);
}

/** Public, password-free view for the Settings UI. */
export async function getSmtpSettingsPublic(): Promise<SmtpSettingsPublic> {
  const row = await queryOne<{ value: SmtpRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [SMTP_KEY],
  );
  if (row) {
    return {
      fromEmail: row.value.user,
      fromName: row.value.fromName,
      hasPassword: true,
    };
  }
  return {
    fromEmail: env.SMTP_USER ?? '',
    fromName: env.SMTP_FROM_NAME ?? 'ALMOG CRM',
    hasPassword: Boolean(env.SMTP_PASS),
  };
}

interface UpdateArgs {
  user: string;
  fromName: string;
  /** Plain App Password (16 chars). If omitted, keep existing pass from DB; throws on first save. */
  pass?: string;
}

export async function updateSmtpSettings(args: UpdateArgs, updatedBy: string): Promise<void> {
  let passEnc: EncryptedBlob;

  if (args.pass) {
    passEnc = encrypt(args.pass);
  } else {
    const existing = await queryOne<{ value: SmtpRow }>(
      `select value from public.app_settings where key = $1 limit 1`,
      [SMTP_KEY],
    );
    if (!existing) {
      throw new AppSettingsValidationError('App Password is required on first save');
    }
    passEnc = existing.value.passEnc;
  }

  const value: SmtpRow = { user: args.user, fromName: args.fromName, passEnc };
  await upsertAppSetting(SMTP_KEY, value, updatedBy);
}

// ── Billing settings (app_settings key 'billing') ────────────────────────

export interface BillingSettings {
  /**
   * Price of the monthly management fee per square metre, in ₪. null = not set.
   * Reference rate for the apartment card's size (m²) / management-fee fields —
   * it never rewrites a fee that was typed manually.
   */
  managementFeePerSqm: number | null;
}

const EMPTY_BILLING: BillingSettings = { managementFeePerSqm: null };

export async function getBillingSettings(): Promise<BillingSettings> {
  const row = await queryOne<{ value: Partial<BillingSettings> }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [BILLING_KEY],
  );
  const raw = row?.value?.managementFeePerSqm;
  const n = typeof raw === 'number' ? raw : null;
  return { managementFeePerSqm: n !== null && Number.isFinite(n) && n >= 0 ? n : EMPTY_BILLING.managementFeePerSqm };
}

/** Persist the billing settings. `managementFeePerSqm: null` clears the rate. */
export async function updateBillingSettings(
  settings: BillingSettings,
  updatedBy: string,
): Promise<void> {
  const fee = settings.managementFeePerSqm;
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
    throw new AppSettingsValidationError('management fee per sqm must be a non-negative number');
  }
  await upsertAppSetting(BILLING_KEY, { managementFeePerSqm: fee }, updatedBy);
}

/**
 * Re-derive contacts.management_fee for every apartment that has a size, using
 * the formula size × 150% × rate. Called after the rate changes so no apartment
 * keeps a fee computed from the old rate. Apartments with no size are left
 * untouched (nothing to derive from), and a cleared rate recomputes nothing.
 * Returns how many rows changed.
 */
export async function recomputeAllManagementFees(ratePerSqm: number | null): Promise<number> {
  if (ratePerSqm === null) return 0;
  const r = await query(
    `update public.contacts
        set management_fee = round((apartment_size_sqm * 1.5 * $1::numeric)::numeric, 2)
      where apartment_size_sqm is not null
        and management_fee is distinct from round((apartment_size_sqm * 1.5 * $1::numeric)::numeric, 2)`,
    [ratePerSqm],
  );
  return r.rowCount ?? 0;
}

// ── Legal contact (app_settings key 'legal_contact') ─────────────────────

/**
 * The lawyer the building works with — Settings → "עורך דין". Read at send
 * time by the legal-status change notification, which adds this address to
 * the status's own notification_emails when a debtor moves INTO a legal
 * status. Empty strings = not configured, nothing is sent. The address is
 * never hard-coded anywhere; a missing row reads as empty.
 */
export async function getLegalContact(): Promise<LegalContact> {
  const row = await queryOne<{ value: Partial<LegalContact> | null }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [LEGAL_CONTACT_KEY],
  );
  const v = row?.value;
  return {
    email: typeof v?.email === 'string' ? v.email : '',
    name: typeof v?.name === 'string' ? v.name : '',
  };
}

/** Persist the legal contact. '' in both fields clears it. Returns the stored value. */
export async function updateLegalContact(
  input: { email?: unknown; name?: unknown },
  updatedBy: string,
): Promise<LegalContact> {
  const normalized = normalizeLegalContact(input);
  if (!normalized.ok) {
    throw new AppSettingsValidationError(
      normalized.errors.email ?? normalized.errors.name ?? 'legal contact is invalid',
    );
  }
  await upsertAppSetting(LEGAL_CONTACT_KEY, normalized.value, updatedBy);
  return normalized.value;
}

// ── SMTP auth-failure alert throttle (app_settings key 'smtp_last_auth_alert') ─

/** The atomic 6-hour claim behind the SMTP auth alert — the statement lives in
 *  email/smtp-auth-alert.ts, shared with the delivery worker. */
export async function claimSmtpAuthAlertSlot(): Promise<{ at: string } | null> {
  return claimSmtpAuthAlertSlotWith({ query });
}

// ── Chip orders (app_settings key 'chip_orders') ──────────────────────────

const CHIP_ORDERS_KEY = 'chip_orders';

function money(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= CHIP_ORDER_LIMITS.maxPrice ? v : fallback;
}
function count(v: unknown, fallback: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback;
}

/** The price rule and texts of /chip-order. A missing row (or a broken field)
 *  reads as the defaults: 50 ₪, threshold 2, 70 ₪ above it, 4 per apartment,
 *  and the page closed. */
export async function getChipOrderSettings(): Promise<ChipOrderSettings> {
  const row = await queryOne<{ value: Partial<ChipOrderSettings> | null }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [CHIP_ORDERS_KEY],
  );
  const v = row?.value ?? {};
  const d = DEFAULT_CHIP_ORDER_SETTINGS;
  const max = count(v.maxPerApartment, d.maxPerApartment, CHIP_ORDER_LIMITS.maxPerApartmentCeiling);
  return {
    unitPrice: money(v.unitPrice, d.unitPrice),
    threshold: count(v.threshold, d.threshold, CHIP_ORDER_LIMITS.maxPerApartmentCeiling),
    priceAbove: money(v.priceAbove, d.priceAbove),
    maxPerApartment: max >= 1 ? max : d.maxPerApartment,
    pickupText: typeof v.pickupText === 'string' ? v.pickupText : d.pickupText,
    termsText: typeof v.termsText === 'string' ? v.termsText : d.termsText,
    ordersOpen: v.ordersOpen === true,
  };
}

/** Persist the chip-order settings (validated by the route's zod schema). */
export async function updateChipOrderSettings(
  settings: ChipOrderSettings,
  updatedBy: string,
): Promise<ChipOrderSettings> {
  await upsertAppSetting(CHIP_ORDERS_KEY, settings, updatedBy);
  return getChipOrderSettings();
}
