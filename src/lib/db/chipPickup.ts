import 'server-only';
import { query } from '@/lib/db';
import { PICKUP_ORDERER_KEY, type PickupOrder, type PickupPerson } from '@/lib/chipOrders/pickup';
import type { ChipType } from '@/lib/types/chips';

// The guard's pickup screen ("מסירת צ׳יפים", 25/11/2026) — the NARROW read.
//
// This module is the only thing the two routes of /api/chip-pickup read an
// order through, and it selects what the guard needs to hand chips over and
// nothing more: an order's number, its apartment numbers, the names of its
// people and their active chip numbers. No price, amount or payment detail, no
// email, phone or address, no lease, no note — those columns are not in any
// query below, so no change to the screen can put them in a response. The
// static gate (scripts/check-api-auth.mjs) keeps the wide chip modules out of
// those routes.
//
// ONLY orders whose status is `ready` are listed. A reception order is never
// one of them (it is collected the moment it is made).

/** More ready orders than a lobby ever holds; a bound on the answer. */
const READY_LIMIT = 300;

interface OrderRow { id: string; order_number: number; is_test: boolean; full_name: string }
interface ItemRow { id: string; order_id: string; apartment_number: string; has_people: boolean }
interface HolderRow { id: string; order_id: string; item_id: string; full_name: string }
interface ChipRow { chip_number: string | null; chip_type: ChipType; order_id: string; item_id: string; holder_id: string | null }

/**
 * Every order that is ready for pickup, the longest-waiting first, as the
 * pickup screen shows it.
 *
 * The people of an order are its holder lines — whoever the order page listed,
 * and whoever the staff added in the issue window. An apartment line that has
 * no person of the order itself (an order made before 20/11/2026) is its
 * orderer's, so whoever paid is always among the people. A person's chips are
 * the ACTIVE chips issued for that person — including extra chips that were
 * paid for at the reception and added for the same person (they sit on a
 * reception order of their own, linked back by extra_of_holder_id). A chip of
 * the apartment line that names no person goes to the line's first person.
 * The number of an APP chip is not selected: it is no card to hand over.
 */
export async function listReadyPickupOrders(): Promise<PickupOrder[]> {
  const orders = (
    await query<OrderRow>(
      `select id, order_number, is_test, full_name
         from public.chip_orders
        where status = 'ready'
        order by ready_at nulls last, order_number
        limit $1`,
      [READY_LIMIT],
    )
  ).rows;
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);

  const [items, holders, chips] = await Promise.all([
    query<ItemRow>(
      `select i.id, i.order_id, i.apartment_number,
              exists (select 1 from public.chip_order_holders h
                       where h.item_id = i.id and h.source in ('order', 'reception')) as has_people
         from public.chip_order_items i
        where i.order_id = any($1::uuid[])
        order by (select min(h.position) from public.chip_order_holders h where h.item_id = i.id) nulls last,
                 i.created_at,
                 nullif(regexp_replace(i.apartment_number, '\\D', '', 'g'), '')::numeric nulls last,
                 i.apartment_number`,
      [ids],
    ),
    query<HolderRow>(
      `select h.id, h.order_id, h.item_id, h.full_name
         from public.chip_order_holders h
        where h.order_id = any($1::uuid[])
        order by h.position, h.created_at, h.id`,
      [ids],
    ),
    query<ChipRow>(
      `select case when x.chip_type = 'physical' then x.chip_number end as chip_number,
              x.chip_type, x.order_id, x.item_id, x.holder_id
         from (
           select c.chip_number, c.chip_type, c.issued_at, i.order_id, i.id as item_id, c.order_holder_id as holder_id
             from public.chips c
             join public.chip_order_items i on i.id = c.order_item_id
            where i.order_id = any($1::uuid[]) and c.status = 'active'
           union all
           select c.chip_number, c.chip_type, c.issued_at, h.order_id, h.item_id, h.id as holder_id
             from public.chips c
             join public.chip_order_holders e on e.id = c.order_holder_id
             join public.chip_order_holders h on h.id = e.extra_of_holder_id
            where h.order_id = any($1::uuid[]) and c.status = 'active'
         ) x
        order by x.issued_at, x.chip_number`,
      [ids],
    ),
  ]);

  return orders.map((o) => {
    const people: PickupPerson[] = [];
    const apartments: string[] = [];
    let orderer: PickupPerson | null = null;
    for (const item of items.rows) {
      if (item.order_id !== o.id) continue;
      apartments.push(item.apartment_number);
      const ofItem: PickupPerson[] = [];
      if (!item.has_people) {
        // One orderer per order, whatever the number of its old apartment lines.
        if (orderer) orderer.apartment = `${orderer.apartment}, ${item.apartment_number}`;
        else {
          orderer = { key: PICKUP_ORDERER_KEY, name: o.full_name, apartment: item.apartment_number, chips: [] };
          people.push(orderer);
        }
        ofItem.push(orderer);
      }
      for (const h of holders.rows) {
        if (h.item_id !== item.id) continue;
        const person: PickupPerson = { key: h.id, name: h.full_name, apartment: item.apartment_number, chips: [] };
        people.push(person);
        ofItem.push(person);
      }
      for (const c of chips.rows) {
        if (c.item_id !== item.id) continue;
        const person = ofItem.find((p) => p.key === c.holder_id) ?? ofItem[0];
        person?.chips.push({ number: c.chip_number, type: c.chip_type });
      }
    }
    return {
      id: o.id,
      order_number: o.order_number,
      is_test: o.is_test,
      apartments,
      people,
      total: people.reduce((sum, p) => sum + p.chips.length, 0),
    };
  });
}
