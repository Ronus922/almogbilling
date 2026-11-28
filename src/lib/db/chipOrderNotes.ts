import 'server-only';
import type { PoolClient } from 'pg';
import { withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { cleanChipNote } from '@/lib/chipOrders/notes';
import { isOpenChipOrder, type ChipOrderStatus } from '@/lib/chipOrders/model';

// "הערה לשומר" (27/11/2026) — the one writer of chip_orders.guard_note. The
// order window's save calls it inside its own transaction; the reception
// window's line of a web order (POST /api/chip-orders/[id]/guard-note) calls
// setChipOrderGuardNote. Only while the order is open (not collected or
// rejected): after the hand-over the note is history. Who wrote it and when
// are kept on the order, and every change is audited ('guard_note_set', with
// the text before and after). The caller has checked the writer
// (mayWriteChipNote('guard', …)).

/**
 * Writes the guard note of an order the caller holds FOR UPDATE. Text that
 * is empty after cleaning clears it. Returns whether anything changed (the
 * same text again writes nothing and audits nothing).
 */
export async function writeGuardNoteInTx(
  client: Pick<PoolClient, 'query'>,
  orderId: string,
  raw: string | null,
  by: { id: string; name: string },
): Promise<boolean> {
  const note = cleanChipNote(raw);
  const cur = (
    await client.query<{ order_number: number; guard_note: string | null }>(
      `select order_number, guard_note from public.chip_orders where id = $1`,
      [orderId],
    )
  ).rows[0];
  if (!cur || (cur.guard_note ?? null) === note) return false;
  await client.query(
    `update public.chip_orders
        set guard_note = $2,
            guard_note_by = case when $2::text is null then null else $3::uuid end,
            guard_note_by_name = case when $2::text is null then null else $4 end,
            guard_note_at = case when $2::text is null then null else now() end,
            updated_at = now()
      where id = $1`,
    [orderId, note, by.id, by.name.slice(0, 120)],
  );
  await writeAuditInTx(client, {
    actorUserId: by.id,
    action: 'guard_note_set',
    entityType: 'chip_order',
    entityId: orderId,
    metadata: { order_number: cur.order_number, before: cur.guard_note, after: note },
  });
  return true;
}

/** The guard note on its own (the reception window). Null = no such order;
 *  ChipOrderStateError('not_open') once the order was handed over or rejected. */
export async function setChipOrderGuardNote(
  orderId: string,
  raw: string | null,
  by: { id: string; name: string },
): Promise<{ changed: boolean; guard_note: string | null } | null> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<{ status: ChipOrderStatus }>(`select status from public.chip_orders where id = $1 for update`, [orderId])
    ).rows[0];
    if (!o) return null;
    if (!isOpenChipOrder(o.status)) throw new ChipOrderStateError('not_open');
    const changed = await writeGuardNoteInTx(client, orderId, raw, by);
    return { changed, guard_note: cleanChipNote(raw) };
  });
}
