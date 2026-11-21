import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { toPortalE164 } from '@/lib/portal/phone';
import { validatePhone } from '@/lib/validation';
import { isOpenChipOrder, type ChipOrderStatus, type ChipOrderWindow, type ChipOrderWindowChip, type ChipOrderWindowHolder, type ChipOrderWindowItem, type ChipOrderWindowOrder } from '@/lib/chipOrders/model';
import { MAX_CHIPS_PER_GROUP } from '@/lib/chips/issueGroups';
import { issueChipGroupsInTx, ChipNumberTakenError } from '@/lib/db/chips';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import type { ChipHolderUpdate, ChipResidentRole, ChipType, IssueChipGroup } from '@/lib/types/chips';

// The issue window of a chip order (20/11/2026 design): one block per PERSON
// of the order (chip_order_holders), the order's transaction details, and one
// save for everything — holder edits, new chip numbers for any apartment of the
// order, the internal note — in ONE transaction. Chips are issued through the
// chips module's own issueChipGroupsInTx (soft limit, number collisions, chip
// events), one call per apartment, each chip linked to its order line AND its
// holder line.

interface ChipRow extends ChipOrderWindowChip {
  live_phone: string | null;
  issued_at: string;
}

const e164 = (p: string | null | undefined): string | null => (p ? toPortalE164(p) : null);

/** Everything the window shows for the order of one Orders-tab row. Null when
 *  the line does not exist or its order was never paid. */
export async function getChipOrderWindow(itemId: string): Promise<ChipOrderWindow | null> {
  const order = await queryOne<ChipOrderWindowOrder>(
    `select o.id, o.order_number, o.status, o.role, o.is_test, o.phone_verified, o.full_name, o.phone_e164, o.email,
            o.address, o.total::float8 as total, o.paid_at, o.due_at, o.created_at, o.internal_note
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
      where i.id = $1 and o.status <> 'pending_payment'`,
    [itemId],
  );
  if (!order) return null;
  const items = (
    await query<ChipOrderWindowItem>(
      `select i.id, i.contact_id, i.apartment_number, i.chips_count, i.unit_price::float8 as unit_price, i.threshold,
              i.price_above::float8 as price_above, i.line_total::float8 as line_total,
              i.lease_file_key, i.lease_file_name, to_char(i.lease_end_date, 'YYYY-MM-DD') as lease_end_date,
              (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as chips_linked
         from public.chip_order_items i
        where i.order_id = $1
        order by (select min(h.position) from public.chip_order_holders h where h.item_id = i.id) nulls last,
                 i.created_at,
                 nullif(regexp_replace(i.apartment_number, '\\D', '', 'g'), '')::numeric nulls last,
                 i.apartment_number`,
      [order.id],
    )
  ).rows;
  const holderRows = (
    await query<Omit<ChipOrderWindowHolder, 'chips' | 'existing'> & { source: 'order' | 'staff' }>(
      `select h.id, h.item_id, h.source, h.role, h.full_name, h.phone, h.email, h.chips_count,
              h.lease_file_key, h.lease_file_name, to_char(h.lease_end_date, 'YYYY-MM-DD') as lease_end_date
         from public.chip_order_holders h
        where h.order_id = $1
        order by h.position, h.created_at, h.id`,
      [order.id],
    )
  ).rows;
  const chips = (
    await query<ChipRow>(
      `select ch.id, ch.chip_number, ch.chip_type, ch.status, ch.contact_id, ch.order_item_id, ch.order_holder_id,
              ch.resident_role, ch.holder_name, ch.holder_phone, ch.issued_at,
              case ch.resident_role when 'owner' then c.owner_phone when 'tenant' then c.tenant_phone
                                    when 'operator' then c.operator_phone else null end as live_phone
         from public.chips ch
         left join public.contacts c on c.id = ch.contact_id
        where ch.contact_id = any($1::uuid[])
        order by ch.issued_at, ch.chip_number, ch.id`,
      [items.map((i) => i.contact_id)],
    )
  ).rows;

  const itemIds = new Set(items.map((i) => i.id));
  const strip = (c: ChipRow): ChipOrderWindowChip => ({
    id: c.id, chip_number: c.chip_number, chip_type: c.chip_type, status: c.status, contact_id: c.contact_id,
    order_item_id: c.order_item_id, order_holder_id: c.order_holder_id, resident_role: c.resident_role,
    holder_name: c.holder_name, holder_phone: c.holder_phone,
  });

  const holders: ChipOrderWindowHolder[] = [];
  for (const item of items) {
    const own = holderRows.filter((h) => h.item_id === item.id);
    const blocks: ChipOrderWindowHolder[] = own.length > 0
      ? own.map((h) => ({ ...h, chips: [], existing: [] }))
      : [{
          // An order from before 20/11/2026: one block for the apartment, from
          // the order's own name and phone.
          id: null, item_id: item.id, source: 'legacy', role: order.role, full_name: order.full_name,
          phone: order.phone_e164, email: order.email, chips_count: item.chips_count,
          lease_file_key: item.lease_file_key, lease_file_name: item.lease_file_name, lease_end_date: item.lease_end_date,
          chips: [], existing: [],
        }];
    for (const c of chips) {
      if (c.contact_id !== item.contact_id) continue;
      const byHolder = c.order_holder_id ? blocks.find((b) => b.id === c.order_holder_id) : undefined;
      if (byHolder) byHolder.chips.push(strip(c));
      else if (!c.order_holder_id && c.order_item_id === item.id) blocks[0].chips.push(strip(c));
    }
    holders.push(...blocks);
  }
  // The same person's earlier chips in the apartment — matched by phone
  // (05…, 9725…, +9725… are one number), each chip to one block at most.
  const claimed = new Set(holders.flatMap((h) => h.chips.map((c) => c.id)));
  for (const h of holders) {
    const phone = e164(h.phone);
    if (!phone) continue;
    const contactId = items.find((i) => i.id === h.item_id)?.contact_id;
    for (const c of chips) {
      if (claimed.has(c.id) || c.contact_id !== contactId || c.order_holder_id) continue;
      if (c.order_item_id && itemIds.has(c.order_item_id)) continue;
      if (e164(c.holder_phone ?? c.live_phone) !== phone) continue;
      h.existing.push(strip(c));
      claimed.add(c.id);
    }
  }
  const clicked = items.find((i) => i.id === itemId) ?? items[0];
  return {
    order,
    items,
    holders,
    clicked_item_id: clicked.id,
    order_all_linked: items.every((i) => i.chips_linked >= i.chips_count),
  };
}

// ── Save ─────────────────────────────────────────────────────────────────

export interface WindowSaveHolder {
  /** An existing holder line, or null: a new staff holder / the first save of
   *  a legacy block. */
  id: string | null;
  item_id: string;
  /** The block of an order from before 20/11/2026 (stored as a holder line now). */
  legacy?: boolean;
  role: ChipResidentRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  new_chips: { number: string; chip_type: ChipType }[];
}

export interface WindowSaveInput {
  holders: WindowSaveHolder[];
  /** Staff holders to remove — only a 'staff' line with no chip (any status)
   *  linked to it; a person of the order (paid) is never removed. */
  removedHolderIds?: string[];
  /** undefined = untouched. */
  note?: string | null;
  issuance_fee?: number | null;
  fee_charged?: boolean;
}

/** A number another chip holds — `holderIndex` is the block's index in the
 *  request, so the window can mark the right row. */
export class WindowChipConflictError extends Error {
  constructor(readonly chipNumber: string, readonly holderIndex: number | null) {
    super('chip_number_taken');
    this.name = 'WindowChipConflictError';
  }
}

export class WindowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowInputError';
  }
}

interface HolderLineRow {
  id: string;
  item_id: string;
  role: ChipResidentRole;
  full_name: string;
  phone: string | null;
  email: string | null;
}

function cleanPhone(raw: string | null, index: number): string | null {
  const p = raw?.trim() ?? '';
  if (!p) return null;
  const v = validatePhone(p);
  if (!v.valid) throw new WindowInputError(`${v.error ?? 'מספר טלפון לא תקין'} (בעל צ׳יפ ${index + 1})`);
  return e164(v.normalized) ?? v.normalized;
}

/**
 * "שמור שינויים" of the order window. One transaction:
 *   1. the order is locked and must still be open (paid / ready);
 *   2. every block: an existing holder line is updated (role, name, phone,
 *      email); a new staff holder or a legacy block becomes a holder line
 *      (staff: chips_count 0 — never part of the paid quantity or the total);
 *   3. per apartment, ONE issueChipGroupsInTx call issues the new numbers
 *      (linked to the order line and the holder line) and applies the holder's
 *      name / phone / role to the chips already linked to it;
 *   4. the internal note.
 * Returns null when the order does not exist.
 */
export async function saveChipOrderWindow(
  orderId: string,
  input: WindowSaveInput,
  actor: { id: string; name: string },
): Promise<{ issued: number; updated: number } | null> {
  return withTransaction(async (client: PoolClient) => {
    const order = (
      await client.query<{ status: ChipOrderStatus; order_number: number }>(
        `select status, order_number from public.chip_orders where id = $1 for update`,
        [orderId],
      )
    ).rows[0];
    if (!order) return null;
    if (!isOpenChipOrder(order.status)) throw new ChipOrderStateError('not_open');

    const items = (
      await client.query<{ id: string; contact_id: string; chips_count: number }>(
        `select id, contact_id, chips_count from public.chip_order_items where order_id = $1`,
        [orderId],
      )
    ).rows;
    const lines = new Map(
      (
        await client.query<HolderLineRow>(
          `select id, item_id, role, full_name, phone, email from public.chip_order_holders where order_id = $1 for update`,
          [orderId],
        )
      ).rows.map((h) => [h.id, h]),
    );
    let nextPosition = (
      await client.query<{ n: number }>(
        `select coalesce(max(position), -1)::int + 1 as n from public.chip_order_holders where order_id = $1`,
        [orderId],
      )
    ).rows[0].n;

    for (const id of input.removedHolderIds ?? []) {
      const r = await client.query(
        `delete from public.chip_order_holders h
          where h.id = $1 and h.order_id = $2 and h.source = 'staff'
            and not exists (select 1 from public.chips c where c.order_holder_id = h.id)`,
        [id, orderId],
      );
      if ((r.rowCount ?? 0) === 0) throw new WindowInputError('אפשר להסיר רק בעל צ׳יפ שנוסף בחלון ואין לו צ׳יפים');
      lines.delete(id);
    }

    type PerContact = { groups: IssueChipGroup[]; groupHolder: number[]; updates: ChipHolderUpdate[] };
    const byContact = new Map<string, PerContact>();
    const forContact = (contactId: string) => {
      let c = byContact.get(contactId);
      if (!c) { c = { groups: [], groupHolder: [], updates: [] }; byContact.set(contactId, c); }
      return c;
    };

    for (const [index, h] of input.holders.entries()) {
      const item = items.find((i) => i.id === h.item_id);
      if (!item) throw new WindowInputError('order_item_not_in_order');
      const name = h.full_name.trim();
      const phone = cleanPhone(h.phone, index);
      const email = h.email?.trim() ? h.email.trim().toLowerCase() : null;
      if (name.length < 2) {
        if (h.id || h.new_chips.length > 0 || h.legacy) throw new WindowInputError(`נדרש שם מלא לבעל הצ׳יפ (בעל צ׳יפ ${index + 1})`);
        continue; // an empty new block — nothing to keep
      }

      let holderId: string;
      if (h.id) {
        const cur = lines.get(h.id);
        if (!cur || cur.item_id !== item.id) throw new WindowInputError('holder_not_in_order');
        holderId = h.id;
        if (cur.role !== h.role || cur.full_name !== name || cur.phone !== phone || (cur.email ?? null) !== email) {
          await client.query(
            `update public.chip_order_holders set role = $2, full_name = $3, phone = $4, email = $5, updated_at = now() where id = $1`,
            [h.id, h.role, name, phone, email],
          );
        }
      } else {
        // A legacy block becomes the apartment's 'order' holder line (with the
        // paid quantity); anything else the staff added is a 'staff' holder.
        const legacy = h.legacy === true
          && (await client.query(`select 1 from public.chip_order_holders where item_id = $1 limit 1`, [item.id])).rowCount === 0;
        if (legacy && !phone) throw new WindowInputError(`נדרש טלפון לבעל הצ׳יפ (בעל צ׳יפ ${index + 1})`);
        holderId = (
          await client.query<{ id: string }>(
            `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, email, chips_count)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
            [orderId, item.id, nextPosition++, legacy ? 'order' : 'staff', h.role, name, phone, email, legacy ? item.chips_count : 0],
          )
        ).rows[0].id;
        if (legacy) {
          // The apartment's chips issued for the order before it had holder lines.
          await client.query(
            `update public.chips set order_holder_id = $1, updated_at = now()
              where order_item_id = $2 and order_holder_id is null`,
            [holderId, item.id],
          );
        }
      }

      const bucket = forContact(item.contact_id);
      const chipPhone = phone ? validatePhone(phone).normalized || phone : null;
      // The holder's name / phone / role reach the chips already linked to it.
      const linked = (
        await client.query<{ id: string; holder_name: string | null; holder_phone: string | null; resident_role: ChipResidentRole }>(
          `select id, holder_name, holder_phone, resident_role from public.chips where order_holder_id = $1`,
          [holderId],
        )
      ).rows;
      for (const c of linked) {
        const patch: ChipHolderUpdate = { id: c.id };
        if ((c.holder_name ?? null) !== name) patch.holder_name = name;
        if ((e164(c.holder_phone) ?? c.holder_phone ?? null) !== (e164(chipPhone) ?? chipPhone)) patch.holder_phone = chipPhone;
        if (c.resident_role !== h.role) patch.resident_role = h.role;
        if (Object.keys(patch).length > 1) bucket.updates.push(patch);
      }
      // New numbers, per type, in groups the chips module accepts.
      for (const type of ['physical', 'app'] as const) {
        const nums = h.new_chips.filter((n) => n.chip_type === type).map((n) => n.number.trim()).filter(Boolean);
        for (let k = 0; k < nums.length; k += MAX_CHIPS_PER_GROUP) {
          bucket.groups.push({
            resident_role: h.role,
            holder_name: name,
            holder_phone: chipPhone,
            chip_type: type,
            numbers: nums.slice(k, k + MAX_CHIPS_PER_GROUP),
            order_item_id: item.id,
            order_holder_id: holderId,
          });
          bucket.groupHolder.push(index);
        }
      }
    }

    let issued = 0;
    let updated = 0;
    for (const [contactId, b] of byContact) {
      if (b.groups.length === 0 && b.updates.length === 0) continue;
      try {
        const r = await issueChipGroupsInTx(
          client,
          {
            contact_id: contactId,
            groups: b.groups,
            updates: b.updates,
            issuance_fee: input.issuance_fee ?? null,
            fee_charged: input.fee_charged === true,
            notes: null,
          },
          actor,
        );
        issued += r.items.length;
        updated += r.updated.length;
      } catch (err) {
        if (err instanceof ChipNumberTakenError) {
          throw new WindowChipConflictError(err.chipNumber, err.groupIndex !== null ? b.groupHolder[err.groupIndex] ?? null : null);
        }
        throw err;
      }
    }

    if (input.note !== undefined) {
      await client.query(
        `update public.chip_orders set internal_note = $2, updated_at = now() where id = $1`,
        [orderId, input.note?.trim() ? input.note.trim() : null],
      );
    }
    return { issued, updated };
  });
}

/** "מחק הזמנת בדיקה" (20/11/2026): the ACTIVE chips issued for a TEST order —
 *  disabled before the order is deleted. Empty for a real order. */
export async function listActiveChipIdsOfTestOrder(orderId: string): Promise<string[]> {
  const r = await query<{ id: string }>(
    `select c.id from public.chips c
       join public.chip_order_items i on i.id = c.order_item_id
       join public.chip_orders o on o.id = i.order_id
      where o.id = $1 and o.is_test and c.status = 'active'
      order by c.issued_at`,
    [orderId],
  );
  return r.rows.map((row) => row.id);
}
