import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  resolveSelectionRecipients, resolveConsolidatedSelectionRecipients,
  listInvalidSelectionPhones, parseBroadcastDebtFilter, maskPhoneIntl,
} from '@/lib/whatsapp-broadcast';
import {
  interpolateTemplate, interpolateBroadcastTemplate, isDebtMessageTemplate,
  templateUsesApartmentOutsideBlock, resolveConsolidatedName, resolveName,
  sortByApartmentNumberAscending,
} from '@/lib/whatsapp-template';
import type { BroadcastRoleSelection } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLE_SELECTIONS: readonly BroadcastRoleSelection[] = ['owners', 'tenants', 'suppliers'];

interface PreviewRecipient {
  /** 'resident' covers both owners and tenants — resolveSelectionRecipients'
   *  union doesn't preserve which role matched (a phone reached via either
   *  role is a single recipient either way), matching the campaign detail
   *  page's OWN recipient log, which also shows no owner/tenant distinction. */
  kind: 'resident' | 'supplier';
  name: string;
  apartmentNumber: string | null;
  /** How many MORE apartments beyond apartmentNumber this one phone covers
   *  (a debt-message consolidated recipient holding several units) — 0 for a
   *  free-form message or a single-apartment/supplier recipient. */
  extraApartmentCount: number;
  phoneMasked: string;
  /** The debt-message apartment list was cut short by the truncation budget
   *  (interpolateBroadcastTemplate) — always false for a free-form message. */
  truncated: boolean;
  message: string;
}

// POST /api/whatsapp/campaigns/preview — Section 7: resolves the exact same
// recipients POST /api/whatsapp/campaigns would create (same resolvers, same
// hard blocks, same rendering), but PERSISTS NOTHING — a pure read, so the
// operator can review who gets what BEFORE the real send. Deliberately a
// SEPARATE, self-contained route rather than a shared helper with the
// campaign-creation route: this keeps the already-shipped, already-deployed
// send path (POST /api/whatsapp/campaigns) completely untouched — zero
// regression risk to real WhatsApp sends for a purely-additive review step.
// whatsapp_chat:edit (not :view) — this is a step INSIDE the send flow, same
// gate as creating the campaign itself.
export async function POST(req: NextRequest) {
  try { await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let body: { roles?: unknown; body?: unknown; debt_filter?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const messageBody = typeof body.body === 'string' ? body.body : '';
  if (!messageBody.trim()) return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });

  const roles = Array.isArray(body.roles)
    ? Array.from(new Set(body.roles.filter((x): x is BroadcastRoleSelection => (ROLE_SELECTIONS as readonly string[]).includes(x as string))))
    : [];
  if (roles.length === 0) return NextResponse.json({ error: 'קהל יעד לא תקין' }, { status: 400 });

  const parsedFilter = parseBroadcastDebtFilter(body.debt_filter);
  if (!parsedFilter.ok) return NextResponse.json({ error: parsedFilter.error }, { status: 400 });
  const debtFilter = parsedFilter.value;

  const isDebt = isDebtMessageTemplate(messageBody);
  const selectionIncludesSuppliers = roles.includes('suppliers');

  // Same hard block as campaign creation, same message — fail loudly here too,
  // before the operator even gets to a preview that could never be sent as-is.
  if (isDebt && selectionIncludesSuppliers) {
    return NextResponse.json({
      error: 'לא ניתן לשלוח הודעת חוב (עם משתני חוב/דירה) לקהל שכולל ספקים — לספקים אין דירה או חוב. הסירו את "ספקים" מקהל היעד, או השתמשו בתבנית ללא משתני חוב.',
    }, { status: 400 });
  }

  const recipients: PreviewRecipient[] = [];
  let partialDetailCount = 0;

  if (isDebt) {
    const consolidated = await resolveConsolidatedSelectionRecipients(roles, debtFilter);
    if (consolidated.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });

    if (templateUsesApartmentOutsideBlock(messageBody)) {
      const affected = consolidated.filter((r) => r.apartments.length > 1).length;
      if (affected > 0) {
        return NextResponse.json({
          error: `התבנית משתמשת ב-{{apartment}} מחוץ לקטע החוזר, ו-${affected} נמענים מחזיקים יותר מדירה אחת — לא ברור איזו דירה להציג. עטפו את החלק שחוזר לכל דירה ב-{{#apartments}}...{{/apartments}}.`,
        }, { status: 400 });
      }
    }

    for (const r of consolidated) {
      const apartments = sortByApartmentNumberAscending(r.apartments);
      const rep = apartments[0];
      const rendered = interpolateBroadcastTemplate(messageBody, { name: resolveConsolidatedName(r.rawNames), apartments });
      if (rendered.truncated) partialDetailCount += 1;
      recipients.push({
        kind: 'resident', // consolidated recipients are always owners/tenants, never suppliers (blocked above)
        name: resolveConsolidatedName(r.rawNames) || 'דייר יקר',
        apartmentNumber: rep.apartment_number,
        extraApartmentCount: apartments.length - 1,
        phoneMasked: maskPhoneIntl(r.phoneIntl),
        truncated: rendered.truncated,
        message: rendered.text,
      });
    }
  } else {
    const resolved = await resolveSelectionRecipients(roles, debtFilter);
    if (resolved.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });

    for (const r of resolved) {
      if (r.kind === 'supplier') {
        const message = interpolateTemplate(messageBody, {
          owner_name: r.name, tenant_name: null, apartment_number: null,
          total_debt: null, management_fees: null, hot_water_debt: null,
        });
        recipients.push({
          kind: 'supplier', name: r.name || 'ספק', apartmentNumber: null, extraApartmentCount: 0,
          phoneMasked: maskPhoneIntl(r.phoneIntl), truncated: false, message,
        });
      } else {
        recipients.push({
          kind: 'resident',
          name: resolveName(r.debtor),
          apartmentNumber: r.debtor.apartment_number ?? null,
          extraApartmentCount: 0,
          phoneMasked: maskPhoneIntl(r.phoneIntl),
          truncated: false,
          message: interpolateTemplate(messageBody, r.debtor),
        });
      }
    }
  }

  // Section 6's invalid-phone entries — the "rejected" list: who's in the
  // selected audience but won't get this message at all, and why.
  const rejected = await listInvalidSelectionPhones(roles, debtFilter);

  return NextResponse.json({
    count: recipients.length,
    partial_detail_count: partialDetailCount,
    invalid_phone_count: rejected.length,
    recipients,
    rejected,
  });
}
