import type { ChipType } from '@/lib/types/chips';

// The guard's pickup screen ("מסירת צ׳יפים", 25/11/2026) — the pure,
// client-safe half: the ONLY shape of an order the screen ever receives, the
// search of the screen, and who may be named as the person who collected.
//
// Residents collect their chips from the guard in the lobby, against an ID
// that matches one of the people of the order. The guard therefore needs to
// know, for an order that is ready: its number, its apartment(s), its people,
// and the chips of each. And nothing else — the shape below is the whole
// answer of GET /api/chip-pickup, built field by field on the server
// (src/lib/db/chipPickup.ts). A price, an amount, a payment detail, an email,
// a phone, an address, a lease, a note or a test-mode control is not hidden on
// this screen: it never leaves the server.

/** One chip to hand over. A card has the number printed on it — the guard
 *  matches the card in hand against it. An APP chip is nothing the guard hands
 *  over, and its "number" is an identifier of the person's app account: it is
 *  counted, and its number never leaves the server (null). */
export interface PickupChip {
  number: string | null;
  type: ChipType;
}

/** One person of the order — whoever may show an ID for it. */
export interface PickupPerson {
  /** What the hand-over names: the person's holder line id, or
   *  PICKUP_ORDERER_KEY for the orderer of an order that has no holder lines. */
  key: string;
  name: string;
  /** The apartment the person's chips are for ("12", or "12, 14"). */
  apartment: string;
  /** The ACTIVE chips issued for the person. */
  chips: PickupChip[];
}

/** One order that is ready for pickup. */
export interface PickupOrder {
  id: string;
  order_number: number;
  /** A test-mode order — shown with a "בדיקה" tag so nobody takes it for a
   *  resident's. A fact about the order, not a control. */
  is_test: boolean;
  apartments: string[];
  people: PickupPerson[];
  /** Every chip of the order (the sum over its people). */
  total: number;
}

/** The orderer of an order made before 20/11/2026 — it has no holder lines,
 *  so its one person is whoever ordered. */
export const PICKUP_ORDERER_KEY = 'orderer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value that MAY name a person of an order: a holder line id, or the
 *  orderer. Whether it names a person of THIS order is the server's question. */
export function isPickupPersonKey(v: unknown): v is string {
  return typeof v === 'string' && (v === PICKUP_ORDERER_KEY || UUID_RE.test(v));
}

const fold = (s: string) => s.toLocaleLowerCase('he').trim();

/** The screen's search: by apartment number and by name. Like the Orders tab —
 *  the text is split into words, every word must be found, each in any of the
 *  fields. A word made of digits is an apartment number, matched from its
 *  beginning ("12" finds apartment 12 and 120, never 212): a guard who types
 *  an apartment is not handed every number that merely contains it. */
export function filterPickupOrders(orders: PickupOrder[], query: string): PickupOrder[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return orders;
  return orders.filter((o) => {
    const apartments = o.apartments.map(fold);
    const names = o.people.map((p) => fold(p.name));
    return words.every((w) => (
      /^\d+$/.test(w)
        ? apartments.some((a) => a.startsWith(w))
        : names.some((n) => n.includes(w)) || apartments.some((a) => a.includes(w))
    ));
  });
}

/** "צ׳יפ אחד" / "3 צ׳יפים". */
export function chipsCountText(n: number): string {
  return n === 1 ? 'צ׳יפ אחד' : `${n} צ׳יפים`;
}

/** The people of an order as the confirmation offers them: one entry per
 *  person (a person never appears twice), in the order of the list. */
export function pickupCollectors(order: Pick<PickupOrder, 'people'>): Pick<PickupPerson, 'key' | 'name' | 'apartment'>[] {
  const seen = new Set<string>();
  const out: Pick<PickupPerson, 'key' | 'name' | 'apartment'>[] = [];
  for (const p of order.people) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key, name: p.name, apartment: p.apartment });
  }
  return out;
}
