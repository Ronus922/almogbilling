import 'server-only';
import { logger } from '@/lib/logger';
import { alertChipOrderAdmins } from './alerts';
import {
  claimDueDocuments, failDocument, getDocumentSource, hasDueDocuments, markDocumentIssued, postponeDocument,
  recordDocumentProgress, renewDocumentClaim, rescheduleDocument, type ClaimedDocument, type DocumentEmail, type IssuedMorningDoc,
} from '@/lib/db/chipOrderDocuments';
import {
  createDocument, morningConfig, MorningApiError, readBusinessProfile, searchDocuments,
  type MorningBusinessProfile, type MorningConfig,
} from '@/lib/morning/client';
import {
  buildCreditBodies, buildInvoiceBody, chooseDocumentType, DocumentBuildError, incomeLinesOf, israelDate,
  BUSINESS_TYPE_LABEL, DOC_TYPE_LABEL, type DocClient, type DocPaymentMethod, type DocTypeChoice, type MorningDocType,
} from '@/lib/morning/documents';

// The ISSUER of the Morning documents of chip orders (26/11/2026). The queue is
// chip_order_documents (src/lib/db/chipOrderDocuments.ts): a row is written in
// the same transaction as the money movement, and this module turns due rows
// into documents in the building's Morning account.
//
//   - ASYNCHRONOUS: nothing waits for Morning. Triggers: right after the
//     movement (after()), every hourly purge run, and whenever staff load the
//     orders list — each only claims what is due.
//   - IDEMPOTENT: one row per payment (UNIQUE payment_key); a row is claimed
//     with FOR UPDATE SKIP LOCKED; a row whose run never finished is first
//     SEARCHED for in Morning (its ref is printed in the remarks) before it is
//     issued again, so a crash between Morning's answer and our UPDATE never
//     makes a second document.
//   - RETRIES with backoff (1, 5, 15, 60, 180 minutes) on what may pass by
//     itself (no reply, throttling, a server error). A refusal of the request
//     itself, or the last attempt, makes the row 'failed': the orders table
//     shows "חשבונית לא הופקה", every active admin gets a bell + email alert,
//     and "הפק חשבונית שוב" puts it back in the queue.
//   - NO KEY → NOTHING IS ATTEMPTED: while MORNING_API_KEY_ID / _SECRET are
//     empty the rows wait, unclaimed, and the order shows "חשבונית ממתינה
//     לחיבור מורנינג".
//   - The document type is the account's (chooseDocumentType): while Morning
//     cannot say whether the business is VAT-exempt nothing is issued.

const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
export const MAX_DOCUMENT_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const PROFILE_TTL_MS = 10 * 60_000;
const CLAIM_LIMIT = 10;

export interface MorningStatus {
  configured: boolean;
  mode: 'production' | 'sandbox' | null;
  profile: MorningBusinessProfile | null;
  choice: DocTypeChoice | null;
  /** Why the account could not be read (never a secret). */
  error: string | null;
}

let profileCache: { at: number; key: string; status: MorningStatus } | null = null;

/** Tests only. */
export function __resetMorningProfileForTests(): void {
  profileCache = null;
}

/** What the building's Morning account says about itself, and the document
 *  type that follows (cached for 10 minutes). Never throws. */
export async function morningStatus(force = false): Promise<MorningStatus> {
  const cfg = morningConfig();
  if (!cfg) return { configured: false, mode: null, profile: null, choice: null, error: null };
  const key = `${cfg.mode}:${cfg.clientId}`;
  if (!force && profileCache && profileCache.key === key && Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.status;
  let status: MorningStatus;
  try {
    const profile = await readBusinessProfile(cfg);
    status = { configured: true, mode: cfg.mode, profile, choice: chooseDocumentType(profile), error: null };
  } catch (e) {
    const message = e instanceof MorningApiError ? `${e.status}${e.code ? ` ${e.code}` : ''}: ${e.message}` : (e as Error).name;
    status = { configured: true, mode: cfg.mode, profile: null, choice: null, error: message };
  }
  profileCache = { at: Date.now(), key, status };
  return status;
}

/** A plain-language line for /settings: the business type and the document. */
export function describeMorningChoice(s: MorningStatus): string {
  if (!s.configured) return 'מורנינג לא מחובר — אין מפתח API.';
  if (s.error) return `לא ניתן לקרוא את חשבון המורנינג (${s.error}).`;
  const type = s.profile?.businessType != null ? (BUSINESS_TYPE_LABEL[s.profile.businessType] ?? `סוג ${s.profile.businessType}`) : 'סוג העסק לא נמסר';
  if (!s.choice?.docType) return `${type} — ${s.choice?.reason ?? 'לא נקבע סוג מסמך'}`;
  return `${type} — יופק מסמך ${s.choice.docType} (${DOC_TYPE_LABEL[s.choice.docType]}). ${s.choice.reason}.`;
}

/** The customer gets the receipt by email (Morning is connected). */
export function receiptsAreEmailed(): boolean {
  return morningConfig() !== null;
}

function nextAttemptAt(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts - 1, 0), BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + minutes * 60_000);
}

/** Every active admin is told, once per row. */
async function alertAdmins(row: Pick<ClaimedDocument, 'id' | 'order_id' | 'kind'>, orderNumber: number | null, error: string): Promise<void> {
  const what = row.kind === 'credit' ? 'מסמך זיכוי לא הופק' : 'חשבונית לא הופקה';
  await alertChipOrderAdmins({
    orderId: row.order_id,
    title: `${what}${orderNumber ? ` — הזמנה ${orderNumber}` : ''}`,
    message: `מורנינג לא הפיק את המסמך: ${error.slice(0, 200)}. אפשר ללחוץ „הפק חשבונית שוב” בחלון ההזמנה.`,
    dedupeKey: `chip_doc_failed:${row.id}`,
  });
}

function clientOf(o: { full_name: string; email: string | null; phone_e164: string | null; address_street: string | null; address_city: string | null; address_zip: string | null }): DocClient {
  const phone = o.phone_e164 && /^\+9725\d{8}$/.test(o.phone_e164) ? `0${o.phone_e164.slice(4)}` : o.phone_e164;
  return { name: o.full_name, email: o.email, phone, street: o.address_street, city: o.address_city, zip: o.address_zip };
}

/** What Morning is asked to do with the document's email (27/11/2026). The
 *  request carries client.emails = [the order's email] — Morning sends the
 *  download link there, with the PDF attached (`attachment: true`; Morning's
 *  OpenAPI 2.0.0, CreateDocumentRequest). An order with no email: the
 *  document is issued without one, and that is recorded on its row. */
function emailOf(c: DocClient): DocumentEmail {
  return c.email ? { status: 'sent', to: c.email } : { status: 'no_email' };
}

function detailsDate(details: Record<string, unknown>, fallback: string): string {
  const d = details.date;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : fallback;
}

/** A document of this row that a run which never finished may have created:
 *  same type, its ref in the remarks, issued between the row's day and today. */
async function findLost(cfg: MorningConfig, row: ClaimedDocument, type: number, clientName: string): Promise<IssuedMorningDoc | null> {
  const from = israelDate(new Date(new Date(row.created_at).getTime() - 24 * 3600_000));
  const items = await searchDocuments(cfg, { types: [type], fromDate: from, toDate: israelDate(), clientName });
  const hit = items.find((it) => it.remarks.includes(row.ref) && (it.type === null || it.type === type));
  return hit ? { type, id: hit.id, number: hit.number, url: hit.url } : null;
}

type Outcome = 'issued' | 'retry' | 'failed' | 'postponed';
/** A failure decided inside issueOne (already recorded on the row). */
class RowFailed extends Error {}

async function issueOne(cfg: MorningConfig, choice: DocTypeChoice & { docType: MorningDocType }, row: ClaimedDocument): Promise<Outcome> {
  const src = await getDocumentSource(row);
  if (!src || src.order.is_test) throw new RowFailed(src ? 'הזמנת בדיקה — לא מופק מסמך' : 'ההזמנה לא נמצאה');
  const today = israelDate();
  const method = row.payment_method as DocPaymentMethod;
  const payment = {
    method,
    date: detailsDate(row.details, today) > today ? today : detailsDate(row.details, today),
    last4: typeof row.details.last4 === 'string' ? row.details.last4 : null,
  };
  const lines = incomeLinesOf(src.items.map((i) => ({ chipsCount: i.chips_count, unitPrice: i.unit_price, threshold: i.threshold, priceAbove: i.price_above })));
  const apartments = src.items.map((i) => i.apartment_number);
  const client = clientOf(src.order);
  // Search Morning before posting whenever an earlier attempt may have reached
  // it: a run that never finished, or ANY earlier attempt (a timeout or a 5xx
  // can come back after Morning already created the document) — also one
  // before "הפק חשבונית שוב", which resets the count (`recovering` keeps it).
  const search = row.recovering || row.attempts > 1;

  if (row.kind === 'invoice') {
    if (search) {
      const lost = await findLost(cfg, row, choice.docType, client.name);
      if (lost) {
        await markDocumentIssued(row.id, [lost]);
        return 'issued';
      }
    }
    const body = buildInvoiceBody({
      docType: choice.docType, vatIncluded: choice.vatIncluded, orderNumber: src.order.order_number,
      apartments, client, lines, amount: row.amount, payment, ref: row.ref, date: today,
    });
    const issued = await createDocument(cfg, body);
    await markDocumentIssued(row.id, [issued], emailOf(client));
    return 'issued';
  }

  // A credit: the original must have been issued first.
  if (!src.original || src.original.status === 'failed') {
    throw new RowFailed('אין מסמך מקורי שהופק להזמנה — יש להפיק את מסמך הזיכוי במורנינג ידנית');
  }
  if (src.original.status !== 'issued') {
    await postponeDocument(row.id, 10);
    return 'postponed';
  }
  const original = src.original.morning_docs[0];
  const originalType = original?.type === 400 ? 400 : original?.type === 320 ? 320 : null;
  if (!original || !originalType) throw new RowFailed('סוג המסמך המקורי אינו 320 או 400 — יש לזכות במורנינג ידנית');
  const bodies = buildCreditBodies({
    originalType, originalId: original.id, vatIncluded: choice.vatIncluded, orderNumber: src.order.order_number,
    apartments, client, lines, amount: row.amount, payment, ref: row.ref, date: today,
  });
  const done: IssuedMorningDoc[] = [...row.morning_docs];
  let posted = false;
  for (let k = done.length; k < bodies.length; k++) {
    const type = Number(bodies[k].type);
    let issued: IssuedMorningDoc | null = null;
    if (search) issued = await findLost(cfg, row, type, client.name);
    if (!issued) {
      issued = await createDocument(cfg, bodies[k]);
      posted = true;
    }
    done.push(issued);
    await recordDocumentProgress(row.id, done);
  }
  // The email is recorded when this run posted a document of the row (both
  // carry the same client); one only found again in Morning says nothing new.
  await markDocumentIssued(row.id, done, posted ? emailOf(client) : undefined);
  return 'issued';
}

export interface ProcessResult {
  claimed: number;
  issued: number;
  retried: number;
  failed: number;
  postponed: number;
  /** Nothing was attempted: no key, or the account's document type is unknown. */
  idle: 'no_key' | 'no_document_type' | null;
}

/**
 * Issues what is due. Safe to call from anywhere, any number of times at once
 * (rows are claimed with SKIP LOCKED). Never throws. `orderId` = only that
 * order's rows ("ביטול וזיכוי" issues its credit document before it goes on).
 */
export async function processDueDocuments(limit = CLAIM_LIMIT, orderId: string | null = null): Promise<ProcessResult> {
  const r: ProcessResult = { claimed: 0, issued: 0, retried: 0, failed: 0, postponed: 0, idle: null };
  try {
    const cfg = morningConfig();
    if (!cfg) return { ...r, idle: 'no_key' };
    if (!(await hasDueDocuments(10, orderId))) return r;
    const status = await morningStatus();
    const choice = status.choice;
    if (!choice?.docType) {
      logger.warn('[chip-docs] documents wait: no document type', { reason: status.error ?? choice?.reason ?? 'unknown' });
      return { ...r, idle: 'no_document_type' };
    }
    const rows = await claimDueDocuments(limit, 10, orderId);
    // An invoice before the credit that cancels it, then oldest first (the
    // claim's RETURNING keeps no order): a credit claimed with its own invoice
    // would otherwise wait 10 minutes for it ("ביטול וזיכוי" issues both at once).
    rows.sort((a, b) => (a.kind === b.kind ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime() : a.kind === 'invoice' ? -1 : 1));
    r.claimed = rows.length;
    for (const row of rows) {
      // A batch is worked one row at a time; a row claimed with the batch may
      // have aged past the stale window and been taken over by another run.
      if (!(await renewDocumentClaim(row.id, row.claim))) {
        logger.warn('[chip-docs] row taken over by another run — skipped', { docId: row.id });
        r.claimed--;
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await issueOne(cfg, { ...choice, docType: choice.docType }, row);
      } catch (e) {
        const src = await getDocumentSource(row).catch(() => null);
        const orderNumber = src?.order.order_number ?? null;
        const message = e instanceof MorningApiError
          ? `${e.status}${e.code ? ` ${e.code}` : ''}: ${e.message}`
          : e instanceof DocumentBuildError || e instanceof RowFailed ? e.message : `${(e as Error).name}`;
        const retryable = e instanceof MorningApiError && e.retryable;
        if (retryable && row.attempts < MAX_DOCUMENT_ATTEMPTS) {
          await rescheduleDocument(row.id, message, nextAttemptAt(row.attempts));
          outcome = 'retry';
        } else {
          if (await failDocument(row.id, message)) await alertAdmins(row, orderNumber, message);
          outcome = 'failed';
        }
        logger.warn('[chip-docs] document not issued', { docId: row.id, kind: row.kind, attempt: row.attempts, outcome, message });
      }
      if (outcome === 'issued') r.issued++;
      else if (outcome === 'retry') r.retried++;
      else if (outcome === 'postponed') r.postponed++;
      else r.failed++;
    }
    if (r.claimed > 0) logger.info('[chip-docs] run', { ...r });
  } catch (err) {
    logger.error('[chip-docs] run failed', { err: (err as Error).name, message: (err as Error).message });
  }
  return r;
}
