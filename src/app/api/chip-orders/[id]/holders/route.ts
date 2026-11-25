import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderWindowSaveSchema } from '@/lib/validation/requests';
import { saveChipOrderWindow, WindowChipConflictError, WindowInputError } from '@/lib/db/chipOrderWindow';
import { ReceptionError } from '@/lib/db/chipReception';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { formatIlsAfter } from '@/lib/chipOrders/model';
import { RECEPTION_MAX_PAID_CHIPS } from '@/lib/chipOrders/reception';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/holders — "שמור שינויים" of the order's issue
// window (20/11/2026): the holder blocks (edits, staff-added holders, new chip
// numbers linked to the order line and the holder line) and the internal note,
// in ONE transaction. Issuing chips is chips:edit; doing it for an order is
// also chips_orders_manage:edit — the same two guards the issue window had.
// No limit of active chips per apartment (21/11/2026). The window's fee fields
// ("עמלת הנפקה", "החיוב בוצע") were removed on 25/11/2026: a body that still
// carries them is accepted and they are ignored.
//
// EXTRA CHIPS (25/11/2026): a new number beyond the quantity an apartment line
// paid for online must come with `extra_payment` — "מזומן או העברה" makes a
// reception order for those chips (the web order and its total do not change),
// "ללא חיוב" makes none. The amount is computed HERE from the price of
// /settings; the amount the window showed is only compared with it. Which
// chips are extra is decided here too, from the chips as they are stored at
// that moment — a window that counted differently (a chip of the line changed
// elsewhere meanwhile) is answered payment_required / amount_mismatch and
// loads the order again; nothing is saved. A test order: "ללא חיוב" only.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  if (!hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit')) {
    return NextResponse.json({ error: 'אין הרשאה לשייך צ׳יפים להזמנה' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderWindowSaveSchema);
  if (!body.ok) return body.response;
  try {
    // The price per chip is read here, right before the save — never from the request.
    const { unitPrice } = await getChipOrderSettings();
    const res = await saveChipOrderWindow(
      id,
      {
        holders: body.data.holders.map((h) => ({ ...h, email: h.email || null })),
        removedHolderIds: body.data.removed_holder_ids ?? [],
        note: body.data.note,
        extraPayment: body.data.extra_payment ?? null,
      },
      { id: actor.id, name: actor.full_name ?? actor.username },
      unitPrice,
    );
    if (!res) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...res }, { status: res.issued > 0 ? 201 : 200 });
  } catch (err) {
    // The extra chips of the save (beyond what was paid online) — nothing was saved.
    if (err instanceof ReceptionError) {
      switch (err.code) {
        case 'payment_required':
          return NextResponse.json(
            { error: 'נוספו צ׳יפים מעבר לכמות ששולמה — יש לבחור אמצעי תשלום לצ׳יפים הנוספים', code: err.code, expected_amount: err.expectedAmount },
            { status: 400 },
          );
        case 'amount_mismatch':
          return NextResponse.json(
            {
              error: (err.expectedAmount ?? 0) > 0
                ? `הסכום לתשלום על הצ׳יפים הנוספים הוא ${formatIlsAfter(err.expectedAmount ?? 0)} — בדקו את הסכום ושמרו שוב.`
                : 'מצב הצ׳יפים של ההזמנה השתנה: אין עכשיו צ׳יפים נוספים לתשלום. הנתונים נטענו מחדש — בדקו ושמרו שוב.',
              code: err.code,
              expected_amount: err.expectedAmount,
            },
            { status: 409 },
          );
        case 'test_order_payment':
          return NextResponse.json(
            { error: 'בהזמנת בדיקה לא נרשם תשלום — לצ׳יפים הנוספים יש לבחור „ללא חיוב”', code: err.code },
            { status: 400 },
          );
        case 'nothing_to_charge':
          return NextResponse.json({ error: 'אין סכום לגבייה — יש לבחור „ללא חיוב”', code: err.code }, { status: 400 });
        case 'too_many_chips':
          return NextResponse.json(
            { error: `בתשלום בקבלה אפשר להוסיף עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים לדירה בשמירה אחת`, code: err.code },
            { status: 400 },
          );
        default:
          return NextResponse.json({ error: 'פרטי התשלום על הצ׳יפים הנוספים אינם תקינים', code: err.code }, { status: 400 });
      }
    }
    if (err instanceof WindowChipConflictError) {
      return NextResponse.json(
        { error: `מספר צ׳יפ ${err.chipNumber} כבר פעיל במערכת`, chip_number: err.chipNumber, holder_index: err.holderIndex },
        { status: 409 },
      );
    }
    if (err instanceof WindowInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'invalid_chip_numbers') {
      return NextResponse.json({ error: 'מספרי צ׳יפ לא תקינים' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'order_not_open') {
      return NextResponse.json({ error: 'ההזמנה כבר נאספה או נדחתה — אי אפשר לשייך לה צ׳יפים' }, { status: 409 });
    }
    if (err instanceof Error && err.message === 'holder_not_in_registry') {
      return NextResponse.json({ error: 'לתפקיד זה אין פרטים במרשם הדירה — הזן שם או בחר "אורח"' }, { status: 422 });
    }
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/holders');
  }
}
