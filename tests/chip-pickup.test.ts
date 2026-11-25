import { describe, expect, it } from 'vitest';
import {
  PICKUP_ORDERER_KEY, chipsCountText, filterPickupOrders, isPickupPersonKey, pickupCollectors, type PickupOrder,
} from '@/lib/chipOrders/pickup';
import {
  chipOrderCollectors, chipOrderRowAction, chipOrderRowStatusText, chipOrderRowTags, chipOrderRowTagsText, countOpenChipOrderRows,
} from '@/lib/chipOrders/orderRows';
import { chipOrderStage, chipOrderStageLabel, type ChipOrderRow } from '@/lib/chipOrders/model';
import { extraChipsOf, receptionPaymentReason } from '@/lib/chipOrders/reception';
import { canHandOverChips } from '@/lib/permissions/check';
import { CHIP_PICKUP_ROLES, ROLE_VALUES } from '@/lib/permissions/constants';
import { chipOrderCollectedBodySchema, chipOrderCancelBodySchema, chipPickupHandoverBodySchema } from '@/lib/validation/requests';

// Chips, round six (25/11/2026) — the pure half:
//   · the guard's pickup screen: who may open it, its search (by apartment
//     number and by name), who may be named as the person who collected;
//   · a reception order that was cancelled — stored `rejected`, shown "בוטל",
//     still in the Orders tab, never counted;
//   · the extra chips of a web order's window — what counts as extra.

const H1 = '11111111-1111-4111-8111-111111111111';
const H2 = '22222222-2222-4222-8222-222222222222';
const H3 = '33333333-3333-4333-8333-333333333333';

const ORDERS: PickupOrder[] = [
  {
    id: 'o1', order_number: 1042, is_test: false, apartments: ['12', '14'], total: 3,
    people: [
      { key: H1, name: 'דנה כהן', apartment: '12', chips: [{ number: '7001', type: 'physical' }, { number: '7002', type: 'app' }] },
      { key: H2, name: 'שרה לוי', apartment: '14', chips: [{ number: '7003', type: 'physical' }] },
    ],
  },
  {
    id: 'o2', order_number: 1043, is_test: true, apartments: ['120'], total: 1,
    people: [{ key: PICKUP_ORDERER_KEY, name: 'Yossi Mizrahi', apartment: '120', chips: [{ number: '7004', type: 'physical' }] }],
  },
  {
    id: 'o3', order_number: 1212, is_test: false, apartments: ['212'], total: 0,
    people: [{ key: H3, name: 'רון אבני', apartment: '212', chips: [] }],
  },
];
const found = (q: string) => filterPickupOrders(ORDERS, q).map((o) => o.id);

describe('who may open the pickup screen', () => {
  it('guard, admin and super admin — by role, and nobody else', () => {
    expect([...CHIP_PICKUP_ROLES].sort()).toEqual(['admin', 'guard', 'super_admin']);
    for (const role of ROLE_VALUES) {
      expect(canHandOverChips(role)).toBe(role === 'guard' || role === 'admin' || role === 'super_admin');
    }
  });
});

describe('the search of the pickup screen', () => {
  it('an empty search keeps every order, in order', () => {
    expect(found('')).toEqual(['o1', 'o2', 'o3']);
    expect(found('   ')).toEqual(['o1', 'o2', 'o3']);
  });

  it('a number is an apartment number, matched from its beginning — 12 finds 12 and 120, never 212', () => {
    expect(found('12')).toEqual(['o1', 'o2']);
    expect(found('14')).toEqual(['o1']);
    expect(found('212')).toEqual(['o3']);
    expect(found('2')).toEqual(['o3']);
  });

  it('a number is never matched against the order number', () => {
    // Order 1212 is of apartment 212; "1212" is no apartment.
    expect(found('1212')).toEqual([]);
    expect(found('1042')).toEqual([]);
  });

  it('a name: any person of the order, in any part of the name, in either alphabet', () => {
    expect(found('שרה')).toEqual(['o1']);
    expect(found('לוי')).toEqual(['o1']);
    expect(found('yossi')).toEqual(['o2']);
    expect(found('MIZRAHI')).toEqual(['o2']);
    expect(found('אבני')).toEqual(['o3']);
  });

  it('several words must all be found — a name and an apartment together', () => {
    expect(found('דנה 12')).toEqual(['o1']);
    expect(found('דנה 212')).toEqual([]);
    expect(found('שרה כהן')).toEqual(['o1']);
  });

  it('never looks at a chip number', () => {
    expect(found('7001')).toEqual([]);
  });
});

describe('who may be named as the person who collected', () => {
  it('a holder line id or the orderer is a possible person; anything else is not', () => {
    expect(isPickupPersonKey(H1)).toBe(true);
    expect(isPickupPersonKey(PICKUP_ORDERER_KEY)).toBe(true);
    for (const bad of ['', 'דנה כהן', 'orderer ', '1', `${H1}x`, null, undefined, 7, {}]) expect(isPickupPersonKey(bad)).toBe(false);
  });

  it('the hand-over of the guard needs a person; the management may leave it out', () => {
    expect(chipPickupHandoverBodySchema.safeParse({ person: H1 }).success).toBe(true);
    expect(chipPickupHandoverBodySchema.safeParse({ person: PICKUP_ORDERER_KEY }).success).toBe(true);
    expect(chipPickupHandoverBodySchema.safeParse({}).success).toBe(false);
    expect(chipPickupHandoverBodySchema.safeParse({ person: null }).success).toBe(false);
    expect(chipPickupHandoverBodySchema.safeParse({ person: 'דנה כהן' }).success).toBe(false);

    expect(chipOrderCollectedBodySchema.safeParse({}).success).toBe(true);
    expect(chipOrderCollectedBodySchema.safeParse({ person: null }).success).toBe(true);
    expect(chipOrderCollectedBodySchema.safeParse({ person: H2 }).success).toBe(true);
    // A name typed by hand is not a person of an order.
    expect(chipOrderCollectedBodySchema.safeParse({ person: 'שרה לוי' }).success).toBe(false);
  });

  it('the confirmation offers each person once, in the order of the list', () => {
    const order: PickupOrder = {
      ...ORDERS[0]!,
      people: [...ORDERS[0]!.people, { key: H1, name: 'דנה כהן', apartment: '14', chips: [] }],
    };
    expect(pickupCollectors(order)).toEqual([
      { key: H1, name: 'דנה כהן', apartment: '12' },
      { key: H2, name: 'שרה לוי', apartment: '14' },
    ]);
  });

  it('the management picks from the people of the WHOLE order, over all its apartment rows', () => {
    const rows = [
      { order_id: 'o1', apartment_number: '12', people: ['דנה כהן', 'שרה לוי'], people_keys: [H1, H2] },
      { order_id: 'o1', apartment_number: '14', people: ['דנה כהן', 'מטפלת'], people_keys: [H1, H3] },
      { order_id: 'o2', apartment_number: '7', people: ['מישהו אחר'], people_keys: [PICKUP_ORDERER_KEY] },
    ];
    expect(chipOrderCollectors(rows, 'o1')).toEqual([
      { key: H1, name: 'דנה כהן', apartment: '12' },
      { key: H2, name: 'שרה לוי', apartment: '12' },
      { key: H3, name: 'מטפלת', apartment: '14' },
    ]);
    expect(chipOrderCollectors(rows, 'o2')).toEqual([{ key: PICKUP_ORDERER_KEY, name: 'מישהו אחר', apartment: '7' }]);
    // A row that came without the keys (a tab left open across a deploy) offers nobody.
    expect(chipOrderCollectors([{ order_id: 'o1', apartment_number: '12', people: ['דנה כהן'] } as never], 'o1')).toEqual([]);
  });

  it('counts chips in words', () => {
    expect(chipsCountText(1)).toBe('צ׳יפ אחד');
    expect(chipsCountText(3)).toBe('3 צ׳יפים');
  });
});

describe('a reception order that was cancelled', () => {
  const row = (over: Partial<ChipOrderRow>): ChipOrderRow => ({
    item_id: 'i1', order_id: 'o1', order_number: 1050, contact_id: 'c1', apartment_number: '12',
    full_name: 'דנה כהן', phone_e164: null, role: 'owner', source: 'reception', status: 'rejected',
    chips_count: 2, chips_linked: 0, line_total: 100, people: ['דנה כהן'], people_keys: [H1], extra_of_order_number: null,
    paid_at: '2026-11-25T08:00:00Z', due_at: null, created_at: '2026-11-25T08:00:00Z',
    has_failed_notification: false, is_test: false, phone_verified: true,
    ...over,
  });

  it('is stored rejected and shown "בוטל" — a rejected WEB order is "נדחה"', () => {
    expect(chipOrderStage('rejected', 0, 2, 'reception')).toBe('cancelled');
    expect(chipOrderStageLabel('cancelled', 0, 2)).toBe('בוטל');
    expect(chipOrderStage('rejected', 0, 2, 'web')).toBe('rejected');
    expect(chipOrderStage('rejected', 0, 2)).toBe('rejected');
    expect(chipOrderStageLabel('rejected', 0, 2)).toBe('נדחה');
    expect(chipOrderRowStatusText(row({}))).toBe('בוטל');
  });

  it('has nothing to press — a plain "בוטל" — and is never counted', () => {
    expect(chipOrderRowAction(row({}), undefined)).toEqual({ kind: 'cancelled' });
    // A rejected web order is not in the tab at all, and offers nothing.
    expect(chipOrderRowAction(row({ source: 'web' }), undefined)).toBeNull();
    expect(countOpenChipOrderRows([row({}), row({ status: 'collected' }), row({ source: 'web', status: 'paid' })])).toBe(1);
  });

  it('a reception order made for extra chips of a web order carries the tag "צ׳יפים נוספים" next to "קבלה"', () => {
    expect(chipOrderRowTags(row({ status: 'collected', extra_of_order_number: 1042 }))).toEqual(['reception', 'extra']);
    expect(chipOrderRowTagsText(row({ status: 'collected', extra_of_order_number: 1042 }))).toBe('קבלה, צ׳יפים נוספים');
    expect(chipOrderRowTags(row({ status: 'collected' }))).toEqual(['reception']);
  });

  it('cancelling needs a reason of at least two letters', () => {
    expect(chipOrderCancelBodySchema.safeParse({ reason: 'נרשם בטעות' }).success).toBe(true);
    for (const bad of [{}, { reason: '' }, { reason: ' א ' }, { reason: 'x'.repeat(501) }]) {
      expect(chipOrderCancelBodySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('the extra chips of a web order — beyond what an apartment line paid for', () => {
  it('a new number inside the room the line still has is not extra', () => {
    expect(extraChipsOf([{ ordered: 2, linked: 0, added: 2 }])).toBe(0);
    expect(extraChipsOf([{ ordered: 2, linked: 1, added: 1 }])).toBe(0);
    expect(extraChipsOf([{ ordered: 2, linked: 0, added: 0 }])).toBe(0);
  });

  it('every new number past that room is extra', () => {
    expect(extraChipsOf([{ ordered: 2, linked: 0, added: 3 }])).toBe(1);
    expect(extraChipsOf([{ ordered: 2, linked: 2, added: 2 }])).toBe(2);
    // The line already holds more than it ordered: every new number is extra, no more than that.
    expect(extraChipsOf([{ ordered: 2, linked: 5, added: 1 }])).toBe(1);
  });

  it('a replacement for a disabled chip is not extra — only active chips take room', () => {
    // 2 ordered, one of the two was disabled → 1 active; the new number fills its place.
    expect(extraChipsOf([{ ordered: 2, linked: 1, added: 1 }])).toBe(0);
  });

  it('each apartment line counts for itself — room in one does not absorb the extras of another', () => {
    expect(extraChipsOf([{ ordered: 4, linked: 0, added: 1 }, { ordered: 1, linked: 1, added: 2 }])).toBe(2);
  });

  it('the extras need a payment method, said in their own words', () => {
    expect(receptionPaymentReason({ newChips: 2, method: null, amount: 100, what: 'extra' }))
      .toBe('יש לבחור אמצעי תשלום לצ׳יפים שנוספו מעבר לכמות ששולמה');
    expect(receptionPaymentReason({ newChips: 2, method: null, amount: 100 }))
      .toBe('יש לבחור אמצעי תשלום כדי להנפיק את הצ׳יפים החדשים');
    expect(receptionPaymentReason({ newChips: 0, method: null, amount: 0, what: 'extra' })).toBeNull();
    expect(receptionPaymentReason({ newChips: 2, method: 'none', amount: 100, what: 'extra' })).toBeNull();
    expect(receptionPaymentReason({ newChips: 2, method: 'cash_transfer', amount: 100, confirmedAmount: 100, what: 'extra' })).toBeNull();
    // The sum moved after it was confirmed: the choice no longer stands.
    expect(receptionPaymentReason({ newChips: 3, method: 'cash_transfer', amount: 150, confirmedAmount: 100, what: 'extra' })).toMatch(/הסכום לתשלום השתנה/);
  });
});
