import 'server-only';
import { logger } from '@/lib/logger';
import { isGrowConfigured } from '@/lib/grow/client';
import {
  deleteChipOrderWithLeases, listStaleUnpaidOrders, listTestOrderIds, type OrderDeleteOutcome,
} from '@/lib/db/chipOrders';
import { removeChipOrderLeasesStrict } from '@/lib/storage/chipOrderLeaseStorage';
import { listStaleUnattachedLeases, purgeLeaseIfUnattached } from '@/lib/db/chipLeaseUploads';
import { confirmChipOrderPayment } from './payment';

// Removing chip orders that must not stay (13/11/2026):
//   - the hourly purge of real orders that were never paid (POST
//     /api/cron/chip-orders-purge, billing-chip-orders-purge.timer);
//   - test orders, by hand, from /chips ("מחק הזמנת בדיקה" / "מחק את כל
//     הזמנות הבדיקה").
// Both delete the lease files FIRST and the row after; a file Storage refuses
// keeps its order for the next attempt. A paid order is never deleted.
//
// The same hourly run also sweeps the leases nobody saved (25/11/2026): a
// lease that was uploaded in the issue window and never saved — the window was
// closed without a save, or the file was replaced — is deleted 24 hours after
// its upload. A lease that an order line, a holder line or a chip points at is
// never deleted, and neither is a file this database has no upload row for.

/** An unpaid order is purged this long after it was created. */
export const UNPAID_ORDER_TTL_HOURS = 48;

export interface PurgeResult {
  /** Unpaid real orders older than the TTL that the run looked at. */
  scanned: number;
  deleted: number;
  /** Grow says the order WAS paid — moved to "paid" (the regular status). */
  movedToPaid: number;
  /** Orders that have a Grow process while Grow is not configured — kept. */
  skippedGrowUnavailable: number;
  /** Grow did not answer (or answered an error) — kept for the next run. */
  skippedGrowError: number;
  /** Storage refused a lease file — kept for the next run. */
  fileFailed: number;
  /** Changed under the run (paid or deleted meanwhile) or an unexpected error. */
  skippedOther: number;
  /** Orders that became paid in this run — the caller sends their messages. */
  paidOrderIds: string[];
}

/**
 * Deletes every REAL order still unpaid 48 hours after it was created, with
 * its apartment lines, its messages and its lease files. An order that has a
 * Grow payment process is first checked against Grow's API: paid → it moves
 * to "paid" instead (and is reported for its message); Grow not configured or
 * not answering → kept for a later run. Test orders are never touched here.
 */
export async function purgeUnpaidChipOrders(): Promise<PurgeResult> {
  const r: PurgeResult = {
    scanned: 0, deleted: 0, movedToPaid: 0, skippedGrowUnavailable: 0, skippedGrowError: 0,
    fileFailed: 0, skippedOther: 0, paidOrderIds: [],
  };
  const candidates = await listStaleUnpaidOrders(UNPAID_ORDER_TTL_HOURS);
  r.scanned = candidates.length;
  for (const o of candidates) {
    try {
      if (o.grow_process_id) {
        if (!isGrowConfigured()) {
          r.skippedGrowUnavailable++;
          continue;
        }
        const check = await confirmChipOrderPayment(o.id, 'purge');
        if (check.kind === 'paid') {
          r.movedToPaid++;
          if (check.transitioned) r.paidOrderIds.push(o.id);
          continue;
        }
        if (check.kind !== 'not_paid') {
          r.skippedGrowError++;
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
