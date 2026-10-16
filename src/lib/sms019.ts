// 019sms (docs/sms-provider.md, docs.019sms.co.il) — the request/response shape
// shared by the two callers: the portal OTP adapter (src/lib/portal/sms.ts,
// 'server-only', reads SMS_* from @/env) and the broadcast SMS channel
// (src/lib/wa-queue/smsProvider.ts, which — like wa-queue/provider.ts for
// WhatsApp — stays free of Next 'server-only' deps because it runs in the
// standalone worker). NOT 'server-only' itself and no @/env import, so either
// side can import it safely.
//
// Auth is two independent checks on 019's side: `Authorization: Bearer <token>`
// and `user.username` in the body — see STATUS_MESSAGES 3/10/11 vs 503/504.
// The code itself is generated and verified by us, never by 019 — this is
// their plain SMS send, not their managed OTP product.

export const SMS_019_SEND_URL = 'https://019sms.co.il/api';

export interface Provider019Response {
  status: number;
  message?: string;
  shipment_id?: string;
}

/** 019's errors-and-status.html — only the codes worth a specific message;
 *  everything else falls back to whatever `message` the provider sent. */
export const STATUS_MESSAGES: Record<number, string> = {
  3: 'אימות נכשל — שם משתמש או טוכן שגויים',
  10: 'אימות נכשל — הטוכן פג תוקף',
  11: 'הטוכן תקף אך לא תואם למשתמש, או הוחלף',
  4: 'אין מספיק קרדיט בחשבון 019',
  9: 'מספר הנייד לא תקין (קצר/ארוך מדי)',
  503: 'שם המשתמש (SMS_USERNAME) לא קיים בחשבון 019',
  504: 'הטוכן הנוכחי לא נמצא',
  515: 'שם השולח (SMS_SENDER) לא מאומת בחשבון 019 — יש לאמת בפאנל שלהם (הגדרות → שם שולח טקסטואלי)',
  992: 'שם השולח לא בפורמט תקין — עד 11 תווים, ספרות/אותיות אנגליות בלבד',
};

export function describeProvider019Status(status: number, message?: string): string {
  return STATUS_MESSAGES[status] ?? message ?? 'שגיאה לא מזוהה';
}

export function parseProvider019Response(raw: string): Provider019Response | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && typeof (parsed as Provider019Response).status === 'number'
      ? (parsed as Provider019Response)
      : null;
  } catch {
    return null;
  }
}

export interface Provider019RequestArgs {
  username: string;
  source: string;
  /** 019's expected shape: '5XXXXXXXX' or '05XXXXXXXX'. */
  localPhone: string;
  message: string;
}

export function buildProvider019RequestBody(args: Provider019RequestArgs): string {
  return JSON.stringify({
    sms: {
      user: { username: args.username },
      source: args.source,
      destinations: { phone: [{ _: args.localPhone }] },
      message: args.message,
    },
  });
}
