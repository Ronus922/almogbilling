import 'server-only';
import { logger } from '@/lib/logger';
import { isGrowConfigured } from '@/lib/grow/client';
import { deleteChipOrderWithLeases, listStaleUnpaidOrders } from '@/lib/db/chipOrders';
import { removeChipOrderLeasesStrict } from '@/lib/storage/chipOrderLeaseStorage';
import { confirmChipOrderPayment } from './payment';

// Removing chip orders that must not stay (13/11/2026): the hourly purge of
// real orders that were never paid (POST /api/cron/chip-orders-purge,
// billing-chip-orders-purge.timer). The lease files are deleted FIRST and the
// row after; a file Storage refuses keeps its order for the next attempt. A
// paid order is never deleted.

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
