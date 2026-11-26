import 'server-only';
import { logger } from '@/lib/logger';
import {
  deleteChipOrderWithLeases, listStaleUnpaidOrders, listTestOrderIds, type OrderDeleteOutcome,
} from '@/lib/db/chipOrders';
import { listPendingOrdersWithSessions } from '@/lib/db/chipOrderCard';
import { removeChipOrderLeasesStrict } from '@/lib/storage/chipOrderLeaseStorage';
import { listStaleUnattachedLeases, purgeLeaseIfUnattached } from '@/lib/db/chipLeaseUploads';
import { lookupCardPayment, lookupConfigFor } from './cardPayment';

// Removing chip orders that must not stay (13/11/2026):
//   - the hourly purge of real orders that were never paid (POST
//     /api/cron/chip-orders-purge, billing-chip-orders-purge.timer);
//   - test orders, by hand, from /chips ("מחק הזמנת בדיקה" / "מחק את כל
//     הזמנות הבדיקה").
// Both delete the lease files FIRST and the row after; a file Storage refuses
// keeps its order for the next attempt. A paid order is never deleted.
//
// BEFORE AN UNPAID ORDER IS DELETED, PAYPLUS IS ASKED (26/11/2026): every
// payment session the order ever had is looked up in PayPlus. An approved
// charge there pays the order instead (and its message goes out); PayPlus not
// configured for that environment, or not answering, keeps the order for a
// later run. An order of the former processor (Grow, removed 26/11/2026) can
// no longer be checked and is never deleted here. Nor is an order whose
// sessions one lookup cannot cover (more than PURGE_LOOKUP_MAX_SESSIONS, or one
// older than the lookup's week): "not charged" on part of its sessions is
// never read as "not charged" — it is kept, counted unverifiable. An order
// whose payment page was opened in the last 45 minutes is not touched at all
// (that page may still be charged — listStaleUnpaidOrders and the locked
// re-check of deleteChipOrderWithLeases).
//
// The same run RECONCILES (26/11/2026): an order still waiting for payment —
// a web order or a reception card order — whose payment session is between
// 10 minutes and 48 hours old is looked up in PayPlus, newest session first
// (up to 50 a run) — a charge whose callback was lost while the customer
// closed the page (or the window was closed) is found within the hour, not
// only when the order is purged.
//
// The same hourly run also sweeps the leases nobody saved (25/11/2026): a
// lease that was uploaded in the issue window and never saved — the window was
// closed without a save, or the file was replaced — is deleted 24 hours after
// its upload. A lease that an order line, a holder line or a chip points at is
// never deleted, and neither is a file this database has no upload row for.

/** An unpaid order is purged this long after it was created. */
export const UNPAID_ORDER_TTL_HOURS = 48;

/** Before a purge: every session the order had (no order lives longer than
 *  the TTL plus a run; a week is a generous bound). */
const PURGE_LOOKUP_MINUTES = 7 * 24 * 60;
const PURGE_LOOKUP_MAX_SESSIONS = 25;

export interface PurgeResult {
  /** Unpaid real orders older than the TTL that the run looked at. */
  scanned: number;
  deleted: number;
  /** PayPlus says the order WAS paid — moved to "paid" (the regular status). */
  movedToPaid: number;
  /** The order cannot be checked now (PayPlus of its environment not
   *  configured, an order of the former processor, or sessions one lookup
   *  cannot cover — more than 25, or older than a week) — kept. */
  skippedUnverifiable: number;
  /** PayPlus did not answer (or answered something unreadable) — kept for the next run. */
  skippedLookupError: number;
  /** Storage refused a lease file — kept for the next run. */
  fileFailed: number;
  /** Changed under the run (paid or deleted meanwhile) or an unexpected error. */
  skippedOther: number;
  /** Orders that became paid in this run — the caller sends their messages. */
  paidOrderIds: string[];
}

/**
 * Deletes every REAL order still unpaid 48 hours after it was created, with
 * its apartment lines, its messages and its lease files — after PayPlus was
 * asked about every payment session it had (see the header). Test orders are
 * never touched here.
 */
export async function purgeUnpaidChipOrders(): Promise<PurgeResult> {
  const r: PurgeResult = {
    scanned: 0, deleted: 0, movedToPaid: 0, skippedUnverifiable: 0, skippedLookupError: 0,
    fileFailed: 0, skippedOther: 0, paidOrderIds: [],
  };
  const candidates = await listStaleUnpaidOrders(UNPAID_ORDER_TTL_HOURS);
  r.scanned = candidates.length;
  for (const o of candidates) {
    try {
      if (o.grow_process_id) {
        r.skippedUnverifiable++;
        continue;
      }
      if (o.sessions > 0) {
        const cfg = lookupConfigFor(o.card_env ?? 'production');
        if (!cfg) {
          r.skippedUnverifiable++;
          continue;
        }
        const found = await lookupCardPayment(cfg, o, PURGE_LOOKUP_MAX_SESSIONS, PURGE_LOOKUP_MINUTES);
        if (found.kind === 'paid') {
          r.movedToPaid++;
          if (found.transitioned) r.paidOrderIds.push(found.orderId);
          continue;
        }
        if (found.kind === 'unknown') {
          r.skippedLookupError++;
          continue;
        }
        // Nothing charged on the sessions that were asked about — but a
        // session the lookup did not reach (older than its window, or past its
        // limit) is not ruled out: kept, never "not charged".
        if (found.checked < o.sessions) {
          r.skippedUnverifiable++;
          logger.warn('[chip-orders] purge: sessions beyond one lookup — order kept', { orderId: o.id, sessions: o.sessions, checked: found.checked });
          continue;
        }
      }
      const outcome = await deleteChipOrderWithLeases(o.id, 'unpaid', removeChipOrderLeasesStrict);
      if (outcome === 'deleted') r.deleted++;
      else if (outcome === 'file_failed') {
        r.fileFailed++;
        logger.error('[chip-orders] purge: a lease file was not removed — order kept for the next run', { orderId: o.id });
      } else r.skippedOther++;
    } catch (err) {
      r.skippedOther++;
      logger.error('[chip-orders] purge: order skipped', { orderId: o.id, error: (err as Error).message });
    }
  }
  const { paidOrderIds, ...counts } = r;
  logger.info('[chip-orders] unpaid purge', { ...counts, paid: paidOrderIds.length });
  return r;
}

/** The reconciliation sweep: sessions at least this old (a customer may still
 *  be paying in a younger one), and no older than the purge TTL. */
const RECONCILE_MIN_MINUTES = 10;
const RECONCILE_MAX_MINUTES = UNPAID_ORDER_TTL_HOURS * 60;
const RECONCILE_MAX_PER_RUN = 50;

export interface ReconcileResult {
  scanned: number;
  movedToPaid: number;
  unknown: number;
  paidOrderIds: string[];
}

/** Looks up in PayPlus the orders (web and reception card orders) that still
 *  wait for payment and had a payment session 10 minutes to 48 hours ago (both
 *  environments; the sandbox only while it is configured), newest session
 *  first, and applies what PayPlus reports. */
export async function reconcilePendingCardOrders(): Promise<ReconcileResult> {
  const r: ReconcileResult = { scanned: 0, movedToPaid: 0, unknown: 0, paidOrderIds: [] };
  for (const mode of ['production', 'sandbox'] as const) {
    const cfg = lookupConfigFor(mode);
    if (!cfg) continue;
    const orders = await listPendingOrdersWithSessions(mode, RECONCILE_MIN_MINUTES, RECONCILE_MAX_MINUTES, RECONCILE_MAX_PER_RUN);
    for (const o of orders) {
      r.scanned++;
      try {
        const found = await lookupCardPayment(cfg, o, PURGE_LOOKUP_MAX_SESSIONS, RECONCILE_MAX_MINUTES + 60);
        if (found.kind === 'paid') {
          r.movedToPaid++;
          if (found.transitioned) r.paidOrderIds.push(found.orderId);
        } else if (found.kind === 'unknown') {
          r.unknown++;
        }
      } catch (err) {
        r.unknown++;
        logger.warn('[chip-orders] reconcile: order skipped', { orderId: o.id, error: (err as Error).name });
      }
    }
  }
  if (r.scanned > 0) {
    const { paidOrderIds, ...counts } = r;
    logger.info('[chip-orders] card reconcile', { ...counts, paid: paidOrderIds.length });
  }
  return r;
}

/** A lease nobody saved is deleted this long after it was uploaded. */
export const UNATTACHED_LEASE_TTL_HOURS = 24;

/** The most files one run deletes. A reception attaches a lease or two a day;
 *  a run that finds more than this to delete is not ordinary, and the rest
 *  waits for the next hour (and for whoever reads the journal). */
export const LEASE_PURGE_MAX_PER_RUN = 50;

export interface LeasePurgeResult {
  /** Recorded lease files older than the TTL that nothing saved points at
   *  (at most LEASE_PURGE_MAX_PER_RUN in one run). */
  scanned: number;
  deleted: number;
  /** Attached between the scan and the delete — kept. */
  attached: number;
  /** Storage refused a file — its row stays, the next run retries. */
  fileFailed: number;
  /** Held by a save at that moment, or an unexpected error — the next run. */
  skipped: number;
}

/**
 * The sweep of leases nobody saved. A lease file that the issue window
 * uploaded, and that NO saved order line, holder line or chip points at, is
 * deleted once it is 24 hours old (the file first, its row after). A file that
 * is attached is never deleted — the check is made again, under the row's
 * lock, right before each delete, and a save that is attaching the file at
 * that moment holds the lock (see chipLeaseUploads.ts).
 *
 * The purge works from the rows of chip_lease_uploads alone — it never lists
 * the bucket — so it can only delete a file whose upload THIS database
 * recorded. `remove` is handed in so the rule can be tested against a database
 * alone.
 */
export async function purgeUnattachedLeases(
  remove: (objectKeys: string[]) => Promise<boolean> = removeChipOrderLeasesStrict,
): Promise<LeasePurgeResult> {
  const r: LeasePurgeResult = { scanned: 0, deleted: 0, attached: 0, fileFailed: 0, skipped: 0 };
  const candidates = await listStaleUnattachedLeases(UNATTACHED_LEASE_TTL_HOURS, LEASE_PURGE_MAX_PER_RUN);
  r.scanned = candidates.length;
  for (const key of candidates) {
    try {
      const outcome = await purgeLeaseIfUnattached(key, UNATTACHED_LEASE_TTL_HOURS, remove);
      if (outcome === 'deleted') r.deleted++;
      else if (outcome === 'attached') r.attached++;
      else if (outcome === 'file_failed') {
        r.fileFailed++;
        logger.error('[chip-orders] lease purge: a file was not removed — kept for the next run', { objectKey: key });
      } else r.skipped++;
    } catch (err) {
      r.skipped++;
      logger.error('[chip-orders] lease purge: file skipped', { objectKey: key, error: (err as Error).message });
    }
  }
  logger.info('[chip-orders] unattached lease purge', { ...r });
  return r;
}

export interface TestDeleteResult {
  deleted: number;
  fileFailed: number;
  notFound: number;
}

function tally(outcomes: OrderDeleteOutcome[]): TestDeleteResult {
  return {
    deleted: outcomes.filter((o) => o === 'deleted').length,
    fileFailed: outcomes.filter((o) => o === 'file_failed').length,
    notFound: outcomes.filter((o) => o === 'not_found').length,
  };
}

/** "מחק הזמנת בדיקה" — one TEST order (a real order answers not_found). */
export async function deleteTestChipOrder(id: string): Promise<TestDeleteResult> {
  return tally([await deleteChipOrderWithLeases(id, 'test', removeChipOrderLeasesStrict)]);
}

/** "מחק את כל הזמנות הבדיקה" — every test order, any status. */
export async function deleteAllTestChipOrders(): Promise<TestDeleteResult> {
  const outcomes: OrderDeleteOutcome[] = [];
  for (const id of await listTestOrderIds()) {
    outcomes.push(await deleteChipOrderWithLeases(id, 'test', removeChipOrderLeasesStrict));
  }
  return tally(outcomes);
}
