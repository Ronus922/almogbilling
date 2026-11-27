import 'server-only';
import { NextResponse } from 'next/server';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { logger } from '@/lib/logger';

const MESSAGES: Record<string, { status: number; message: string }> = {
  not_assigning: { status: 409, message: 'אפשר לסמן "מוכן לאיסוף" רק הזמנה שעדיין בשיוך' },
  chips_missing: { status: 409, message: 'עדיין לא שויכו כל הצ׳יפים שהוזמנו' },
  not_ready: { status: 409, message: 'אפשר לסמן "נאסף" רק הזמנה שמוכנה לאיסוף' },
  not_rejectable: { status: 409, message: 'אפשר לדחות רק הזמנה שעדיין בשיוך' },
  chips_active: { status: 409, message: 'להזמנה שויכו צ׳יפים פעילים — יש להשבית אותם בחלון ההנפקה לפני הדחייה' },
  not_open: { status: 409, message: 'ההזמנה כבר נאספה או נדחתה' },
  nothing_to_write: { status: 400, message: 'אין שם או טלפון לעדכן' },
  invalid_phone: { status: 400, message: 'מספר הטלפון אינו תקין לרשימת הדיירים' },
  // The hand-over (25/11/2026): who collected must be a person of the order.
  collector_required: { status: 400, message: 'יש לבחור מי אסף את הצ׳יפים' },
  collector_not_in_order: { status: 400, message: 'האדם שנבחר אינו חלק מההזמנה — רעננו את הרשימה ובחרו שוב' },
  no_active_chips: { status: 409, message: 'להזמנה אין צ׳יפים פעילים למסירה — יש לפנות להנהלה' },
  // "בטל הזמנת קבלה" (25/11/2026).
  not_reception: { status: 409, message: 'אפשר לבטל כך רק הזמנת קבלה — הזמנה מהאתר נדחית בכפתור „דחה”' },
  not_cancellable: { status: 409, message: 'אי אפשר לבצע „ביטול וזיכוי” להזמנה במצבה הנוכחי' },
  // Refunds (26/11/2026).
  not_card_paid: { status: 409, message: 'אפשר לזכות דרך PayPlus רק הזמנה ששולמה בכרטיס' },
  not_web_order: { status: 409, message: 'הזמנת קבלה מבטלים ב„ביטול וזיכוי”' },
  // "ביטול וזיכוי" (27/11/2026).
  already_cancelled: { status: 409, message: 'ההזמנה כבר בוטלה וזוכתה' },
  cancel_in_progress: { status: 409, message: '„ביטול וזיכוי” כבר רץ להזמנה הזו — נסו שוב בעוד כמה דקות' },
  reason_required: { status: 400, message: 'נדרשת סיבת ביטול' },
  payplus_reversed: { status: 409, message: 'PayPlus מראה שהחיוב בוטל או זוכה — ההזמנה לא מתקדמת עד „ביטול וזיכוי” של מנהל מערכת' },
  // "סגירה ידנית" (27/11/2026).
  not_stuck: { status: 409, message: 'סגירה ידנית אפשרית רק כש„ביטול וזיכוי” נעצר בשלב מסמך הזיכוי, או בשלב הזיכוי ב-PayPlus כשנדרשת בדיקה ידנית' },
  document_issuing: { status: 409, message: 'מסמך של ההזמנה נמצא כרגע בהפקה במורנינג — נסו שוב בעוד כמה דקות' },
  // 27/11/2026: a chip works the moment it is issued.
  order_undoing: { status: 409, message: 'הכסף של ההזמנה הוחזר או בדרך חזרה („ביטול וזיכוי”, או ביטול / זיכוי ב-PayPlus) — אי אפשר להנפיק לה צ׳יפים חדשים' },
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
