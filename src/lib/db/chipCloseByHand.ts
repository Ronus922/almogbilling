import 'server-only';
import { withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { deactivateChipInTx } from '@/lib/db/chips';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { closeByHandStep, type CloseByHandStep } from '@/lib/chipOrders/model';

// "סגירה ידנית" (27/11/2026, Ronen): the way out of a run of "ביטול וזיכוי"
// that is stuck for good — Morning keeps refusing the credit document, or the
// refund step needs a person (PayPlus did not answer a refund call and does
// not show it, refused it, or shows more than one charge for the order). SUPER
// ADMIN ONLY (the route), with a reason. It NEVER sends anything to PayPlus or
// Morning: in ONE transaction the order's documents that are still waiting are
// stopped (failed, with the words; the queue and "הפק שוב" never take them
// again), its active chips are disabled (never deleted), the order is
// cancelled (a web order still open → rejected; one handed over stays
// collected; a reception order → rejected, as "ביטול וזיכוי" leaves it), the
// run is finished, and the order keeps for good who closed it, when, why and
// at which step (closed_by_hand_*). Audited ('cancel_closed_by_hand'). Nobody
// is messaged: what happened to the money is the management's to tell.

/** What the documents queue writes on a document "סגירה ידנית" stopped. */
export const CLOSED_BY_HAND_DOCUMENT_ERROR = 'ההזמנה נסגרה ידנית — המסמך לא יופק במורנינג';

export interface ClosedByHand {
  order_number: number;
  source: string;
  step: CloseByHandStep;
  chips_disabled: number;
  documents_stopped: number;
}

/**
 * Closes the order's stuck "ביטול וזיכוי" by hand. Null = no such order.
 * Throws ChipOrderStateError: 'already_cancelled' (the run finished), 'not_stuck'
 * (no step closeByHandStep allows), 'cancel_in_progress' (a run holds it right
 * now), 'document_issuing' (a document of the order is with Morning this very
 * moment — its answer decides; try again in a few minutes).
 */
export async function closeCancelByHand(
  orderId: string,
  reason: string,
  by: { id: string; name: string },
): Promise<ClosedByHand | null> {
  return withTransaction(async (client) => {
    // The documents first, then the order — the order the queue takes them in
    // (markDocumentIssued: the document, then its order), so the two never wait
    // on each other.
    const docs = (
      await client.query<{ id: string; kind: string; status: string }>(
        `select id, kind, status from public.chip_order_documents where order_id = $1 order by created_at for update`,
        [orderId],
      )
    ).rows;
    const o = (
      await client.query<{
        order_number: number; source: string; status: string; cancel_request_reason: string | null;
        cancel_requested: boolean; cancel_completed: boolean; cancel_failed_step: 'refund' | 'credit' | 'cancel' | null;
        refund_status: string | null; refunded_at: Date | null; refund_requested_at: Date | null; running: boolean;
      }>(
        `select order_number, source, status, cancel_request_reason,
                cancel_requested_at is not null as cancel_requested, cancel_completed_at is not null as cancel_completed,
                cancel_failed_step, refund_status, refunded_at, refund_requested_at,
                (cancel_running_until is not null and cancel_running_until > now()) as running
           from public.chip_orders where id = $1 for update`,
        [orderId],
      )
    ).rows[0];
    if (!o) return null;
    if (o.cancel_completed) throw new ChipOrderStateError('already_cancelled');
    const step = closeByHandStep({ ...o, document_failed: docs.some((d) => d.status === 'failed') });
    if (!step) throw new ChipOrderStateError('not_stuck');
    if (o.running) throw new ChipOrderStateError('cancel_in_progress');

    // The documents still waiting are stopped — never issued after this.
    if (docs.some((d) => d.status === 'issuing')) throw new ChipOrderStateError('document_issuing');
    const stopped = docs.filter((d) => d.status === 'pending' || d.status === 'failed');
    if (stopped.length > 0) {
      await client.query(
        `update public.chip_order_documents
            set status = 'failed', claimed_at = null, last_error = $2, updated_at = now()
          where id = any($1::uuid[])`,
        [stopped.map((d) => d.id), CLOSED_BY_HAND_DOCUMENT_ERROR],
      );
    }

    // Its active chips — a chip moved to another apartment since is somebody
    // else's now, and is left alone (as "ביטול וזיכוי" does).
    const active = (
      await client.query<{ id: string; moved: boolean }>(
        `select c.id, (c.contact_id is distinct from i.contact_id) as moved
           from public.chips c
           join public.chip_order_items i on i.id = c.order_item_id
          where i.order_id = $1 and c.status = 'active'
          order by c.issued_at, c.id
          for update of c`,
        [orderId],
      )
    ).rows;
    const chips = active.filter((c) => !c.moved);
    for (const c of chips) {
      await deactivateChipInTx(client, c.id, { reason: 'unknown', note: `סגירה ידנית של הזמנה ${o.order_number}` }, by);
    }

    const reception = o.source === 'reception';
    const close = reception || o.status === 'paid' || o.status === 'approved' || o.status === 'ready';
    const cancelReason = o.cancel_request_reason ?? reason;
    await client.query(
      `update public.chip_orders
          set status = case when $2::boolean then 'rejected' else status end,
              rejected_at = case when $2::boolean then coalesce(rejected_at, now()) else rejected_at end,
              reject_reason = case when $2::boolean then coalesce(reject_reason, $3) else reject_reason end,
              cancelled_by = case when $4::boolean then $5::uuid else cancelled_by end,
              cancelled_by_name = case when $4::boolean then $6 else cancelled_by_name end,
              cancel_failed_step = null, cancel_error = null, cancel_running_until = null,
              cancel_completed_at = now(), payplus_reversal_at = null, payplus_reversal_kind = null,
              closed_by_hand_at = now(), closed_by_hand_by = $5::uuid, closed_by_hand_by_name = $6,
              closed_by_hand_reason = $7, closed_by_hand_step = $8,
              updated_at = now()
        where id = $1`,
      [orderId, close, cancelReason, reception, by.id, by.name.slice(0, 120), reason, step],
    );
    await writeAuditInTx(client, {
      actorUserId: by.id,
      action: 'cancel_closed_by_hand',
      entityType: 'chip_order',
      entityId: orderId,
      metadata: {
        order_number: o.order_number, source: o.source, step, reason, cancel_reason: o.cancel_request_reason,
        status_before: o.status, closed: close, chips_disabled: chips.length, chips_left_moved: active.length - chips.length,
        documents_stopped: stopped.map((d) => ({ kind: d.kind, status_before: d.status })),
        refund_status: o.refund_status, refund_unanswered: o.refund_requested_at !== null && o.refunded_at === null,
      },
    });
    return { order_number: o.order_number, source: o.source, step, chips_disabled: chips.length, documents_stopped: stopped.length };
  });
}
