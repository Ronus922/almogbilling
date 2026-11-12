import 'server-only';
import { NextResponse } from 'next/server';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { logger } from '@/lib/logger';

const MESSAGES: Record<string, { status: number; message: string }> = {
  not_paid: { status: 409, message: 'אפשר לאשר רק הזמנה ששולמה וממתינה לבדיקה' },
  not_approved: { status: 409, message: 'אפשר לסמן "מוכן לאיסוף" רק להזמנה מאושרת' },
  chips_missing: { status: 409, message: 'עדיין לא שויכו כל הצ׳יפים שהוזמנו' },
  not_ready: { status: 409, message: 'אפשר לסמן "נאסף" רק הזמנה שמוכנה לאיסוף' },
  not_rejectable: { status: 409, message: 'אפשר לדחות רק הזמנה ששולמה או שאושרה' },
  chips_active: { status: 409, message: 'להזמנה שויכו צ׳יפים פעילים — יש להשבית אותם בחלון ההנפקה לפני הדחייה' },
  item_not_in_order: { status: 400, message: 'שורה שאינה שייכת להזמנה' },
  invalid_phone: { status: 400, message: 'מספר הטלפון אינו תקין לרשימת הדיירים' },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed order id answers 404 (never reaches Postgres as a uuid cast error). */
export function badOrderId(id: string): NextResponse | null {
  return UUID_RE.test(id) ? null : NextResponse.json({ error: 'not_found' }, { status: 404 });
}

/** Maps a state error of the order to its Hebrew 4xx; anything else is a 500. */
export function chipOrderErrorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof ChipOrderStateError) {
    const m = MESSAGES[err.message] ?? { status: 409, message: 'פעולה לא אפשרית במצב הנוכחי של ההזמנה' };
    return NextResponse.json({ error: m.message }, { status: m.status });
  }
  logger.error(`[${where}]`, err);
  return NextResponse.json({ error: 'server_error' }, { status: 500 });
}
