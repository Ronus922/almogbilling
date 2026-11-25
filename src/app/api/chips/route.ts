import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listChips, ChipNumberTakenError } from '@/lib/db/chips';
import { ReceptionError, saveReceptionWindow, type ReceptionSaveInput } from '@/lib/db/chipReception';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { formatIlsAfter } from '@/lib/chipOrders/model';
import { RECEPTION_MAX_PAID_CHIPS } from '@/lib/chipOrders/reception';
import { legacyChipBodyToInput, MAX_CHIPS_PER_GROUP } from '@/lib/chips/issueGroups';
import {
  CHIP_TABS,
  CHIP_TYPES,
  CHIP_STATUSES,
  CHIP_RESIDENT_ROLES,
  APP_PLATFORMS,
  APP_INVITE_STATUSES,
} from '@/lib/constants/chips';
import { validatePhone } from '@/lib/validation';
import { chipGroupDetailsSchema, chipHolderUpdatesSchema, chipReceptionSchema } from '@/lib/validation/requests';
import { isSnapshotRole } from '@/lib/chips/holder';
import { createNotification } from '@/services/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import type {
  Chip,
  ChipHolderUpdate,
  ChipTab,
  ChipType,
  ChipStatus,
  IssueChipGroup,
  IssueChipsInput,
} from '@/lib/types/chips';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHIP_NUMBERS_ERROR = 'נדרש לפחות מספר צ׳יפ אחד';

/** Bounds on the two free texts of a save (25/11/2026). A name or a note
 *  longer than what an order stores used to pass here and fail deep in the
 *  save — as a 500 whose logged error carried the whole row. */
const HOLDER_NAME_MAX = 120;
const NOTES_MAX = 2000;

/**
 * Notify every active admin (super_admin + admin) — except the issuer — that a
 * new chip was issued. Best-effort, deduped per (chip, admin); never throws
 * (fire-and-forget after the chips are already persisted).
 */
async function notifyAdminsOfChipIssued(
  chip: Chip,
  apartmentLabel: string,
  actorId: string,
): Promise<void> {
  try {
    const message = `צ׳יפ ${chip.chip_number} הונפק לדירה ${apartmentLabel}`;
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      if (admin.id === actorId) continue;
      await createNotification({
        userId: admin.id,
        type: 'chip_issued',
        title: 'צ׳יפ חדש הונפק',
        message,
        sourceModule: 'chips',
        sourceEntityType: 'chip',
        sourceEntityId: chip.id,
        actionUrl: `/chips?chip=${chip.id}`,
        dedupeKey: `chip_issued:${chip.id}:${admin.id}`,
      });
    }
  } catch (err) {
    logger.error('[chips] chip_issued notification failed', err);
  }
}

/** Optional enum coercion: absent/empty → null; a non-member value → invalid. */
function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): { ok: true; value: T | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return { ok: false };
}

/** Optional free-text coercion: trims; absent/blank → null. */
function coerceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' ? trimmed : null;
}

// GET /api/chips?tab&status&chip_type&contact_id&q (chips:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const tabRaw = sp.get('tab')?.trim();
  const tab = tabRaw && CHIP_TABS.includes(tabRaw as ChipTab) ? (tabRaw as ChipTab) : undefined;

  const statusRaw = sp.get('status')?.trim();
  const status =
    statusRaw && statusRaw !== 'all' && CHIP_STATUSES.includes(statusRaw as ChipStatus)
      ? (statusRaw as ChipStatus)
      : undefined;

  const chipTypeRaw = sp.get('chip_type')?.trim();
  const chip_type =
    chipTypeRaw && chipTypeRaw !== 'all' && CHIP_TYPES.includes(chipTypeRaw as ChipType)
      ? (chipTypeRaw as ChipType)
      : undefined;

  const contactIdRaw = sp.get('contact_id')?.trim();
  const contact_id = contactIdRaw && UUID_RE.test(contactIdRaw) ? contactIdRaw : undefined;

  const q = sp.get('q')?.trim() || undefined;

  const items = await listChips({ tab, status, chip_type, contact_id, q });
  return NextResponse.json({ items });
}

/** Validate one raw group entry (new-shape body). Returns the coerced group or
 *  a Hebrew error string. Phone is normalized via validatePhone. */
function coerceGroup(
  rec: Record<string, unknown>,
  index: number,
): { ok: true; group: IssueChipGroup } | { ok: false; error: string } {
  const chipTypeRaw = typeof rec.chip_type === 'string' ? rec.chip_type.trim() : '';
  if (!CHIP_TYPES.includes(chipTypeRaw as ChipType)) {
    return { ok: false, error: `סוג צ׳יפ לא תקין (בלוק ${index + 1})` };
  }
  const residentRole = coerceEnum(rec.resident_role, CHIP_RESIDENT_ROLES);
  if (!residentRole.ok || residentRole.value === null) {
    return { ok: false, error: `נדרש לבחור בעל צ׳יפ (בלוק ${index + 1})` };
  }
  const holderName = coerceText(rec.holder_name);
  if (isSnapshotRole(residentRole.value) && !holderName) {
    return { ok: false, error: `לבעל צ׳יפ מסוג "אורח" נדרש שם מלא (בלוק ${index + 1})` };
  }
  if (holderName && holderName.length > HOLDER_NAME_MAX) {
    return { ok: false, error: `שם ארוך מדי — עד ${HOLDER_NAME_MAX} תווים (בלוק ${index + 1})` };
  }
  const numbers = Array.isArray(rec.numbers)
    ? rec.numbers
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '')
    : [];
  if (numbers.length === 0 || numbers.length > MAX_CHIPS_PER_GROUP) {
    return { ok: false, error: `${CHIP_NUMBERS_ERROR} (בלוק ${index + 1})` };
  }
  const appPlatform = coerceEnum(rec.app_platform, APP_PLATFORMS);
  if (!appPlatform.ok) return { ok: false, error: 'invalid_app_platform' };
  const appInviteStatus = coerceEnum(rec.app_invite_status, APP_INVITE_STATUSES);
  if (!appInviteStatus.ok) return { ok: false, error: 'invalid_app_invite_status' };

  let holderPhone: string | null = null;
  const phoneRaw = coerceText(rec.holder_phone);
  if (phoneRaw !== null) {
    const v = validatePhone(phoneRaw);
    if (!v.valid) {
      return { ok: false, error: v.error ?? `מספר טלפון לא תקין (בלוק ${index + 1})` };
    }
    holderPhone = v.normalized;
  }

  // The holder's email, a renter's lease and its end date, and the window's
  // block (25/11/2026). The fee fields of a group went with the fee fields of
  // the window; a caller that still sends them is ignored.
  const details = chipGroupDetailsSchema.safeParse({
    holder_email: rec.holder_email, lease: rec.lease, lease_end_date: rec.lease_end_date, block: rec.block,
  });
  if (!details.success) {
    return { ok: false, error: `${details.error.issues[0]?.message ?? 'פרטי בעל הצ׳יפ אינם תקינים'} (בלוק ${index + 1})` };
  }

  // Chip orders (13/11/2026): the order line of this group's NEW chips.
  let orderItemId: string | null = null;
  if (rec.order_item_id !== undefined && rec.order_item_id !== null) {
    const raw = typeof rec.order_item_id === 'string' ? rec.order_item_id.trim() : '';
    if (!UUID_RE.test(raw)) return { ok: false, error: 'invalid_order_item_id' };
    orderItemId = raw;
  }

  return {
    ok: true,
    group: {
      resident_role: residentRole.value,
      holder_name: holderName,
      holder_phone: holderPhone,
      chip_type: chipTypeRaw as ChipType,
      numbers,
      app_platform: appPlatform.value,
      app_invite_status: appInviteStatus.value,
      app_expires_at: coerceText(rec.app_expires_at),
      order_item_id: orderItemId,
      ...details.data,
    },
  };
}

// POST /api/chips (chips:edit) — SAVE the issue window: issue chips to one
// contact for zero or more holder groups AND/OR apply holder edits to chips
// already saved there (`updates`), ONE transaction, all-or-nothing. Accepts
// the groups shape ({contact_id, groups:[...], updates?:[...], notes?,
// orderer?, payment?}) AND the legacy flat single-holder body, which is
// adapted to a single group with every field mapped. No limit of active chips
// per apartment and no override reason since 21/11/2026 (a
// limit_override_reason a caller still sends is ignored). 201 when anything
// was issued, 200 for edits only.
//
// ISSUING AT THE RECEPTION (25/11/2026) — the same permission as issuing chips
// always had. A save that issues NEW chips must say how they are paid
// (`payment`): "מזומן או העברה" makes a chip order (source 'reception') that
// is already paid and collected, with the orderer details and one holder line
// per block; "ללא חיוב" makes no order and keeps the details on a reception
// record. The amount is computed HERE from the price of /settings; the amount
// the window showed is only compared with it. Holder edits alone need no
// payment. The old fee fields (`issuance_fee`, `fee_charged`) are no longer
// read — a caller that still sends them is ignored, and nothing writes those
// two columns any more. No message goes to the orderer.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const contactId = typeof bodyRec.contact_id === 'string' ? bodyRec.contact_id.trim() : '';
  if (!UUID_RE.test(contactId)) {
    return NextResponse.json({ error: 'invalid_contact_id' }, { status: 400 });
  }

  if (typeof bodyRec.notes === 'string' && bodyRec.notes.trim().length > NOTES_MAX) {
    return NextResponse.json({ error: `ההערה ארוכה מדי — עד ${NOTES_MAX} תווים` }, { status: 400 });
  }

  // Who ordered, and how the new chips of this save are paid.
  const receptionParsed = chipReceptionSchema.safeParse({ orderer: bodyRec.orderer, payment: bodyRec.payment });
  if (!receptionParsed.success) {
    const issues = receptionParsed.error.issues;
    return NextResponse.json({ error: issues[0]?.message ?? 'invalid_body', issues }, { status: 400 });
  }
  const reception: ReceptionSaveInput = receptionParsed.data;

  let input: IssueChipsInput;

  if (Array.isArray(bodyRec.groups)) {
    // Holder edits of already-saved chips (zod) — may stand alone.
    let updates: ChipHolderUpdate[] = [];
    if (bodyRec.updates !== undefined) {
      const parsed = chipHolderUpdatesSchema.safeParse(bodyRec.updates);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        return NextResponse.json(
          { error: issues[0]?.message ?? 'invalid_updates', issues },
          { status: 400 },
        );
      }
      updates = parsed.data;
    }
    // New shape — zero or more holder groups (zero only alongside updates).
    if (bodyRec.groups.length === 0 && updates.length === 0) {
      return NextResponse.json({ error: CHIP_NUMBERS_ERROR }, { status: 400 });
    }
    const groups: IssueChipGroup[] = [];
    for (let i = 0; i < bodyRec.groups.length; i++) {
      const parsed = coerceGroup((bodyRec.groups[i] ?? {}) as Record<string, unknown>, i);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      groups.push(parsed.group);
    }
    // Chip orders: issuing for an order line is part of handling the order —
    // chips:edit alone is not enough for it.
    if (groups.some((g) => g.order_item_id) && !hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit')) {
      return NextResponse.json({ error: 'אין הרשאה לשייך צ׳יפים להזמנה' }, { status: 403 });
    }
    input = {
      contact_id: contactId,
      groups,
      updates,
      notes: coerceText(bodyRec.notes),
    };
  } else {
    // Legacy flat body — validate exactly as before, then adapt to one group.
    const chipTypeRaw = typeof bodyRec.chip_type === 'string' ? bodyRec.chip_type.trim() : '';
    if (!CHIP_TYPES.includes(chipTypeRaw as ChipType)) {
      return NextResponse.json({ error: 'invalid_chip_type' }, { status: 400 });
    }
    const chipNumbers = Array.isArray(bodyRec.chip_numbers)
      ? bodyRec.chip_numbers
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v !== '')
      : [];
    if (chipNumbers.length === 0 || chipNumbers.length > MAX_CHIPS_PER_GROUP) {
      return NextResponse.json({ error: CHIP_NUMBERS_ERROR }, { status: 400 });
    }
    // resident_role is REQUIRED (product rule 2 + CHECK 074).
    const residentRole = coerceEnum(bodyRec.resident_role, CHIP_RESIDENT_ROLES);
    if (!residentRole.ok || residentRole.value === null) {
      return NextResponse.json(
        { error: 'נדרש לבחור בעל צ׳יפ (בעל דירה / שוכר / מפעיל / אורח)' },
        { status: 400 },
      );
    }
    const holderName = coerceText(bodyRec.holder_name);
    if (isSnapshotRole(residentRole.value) && !holderName) {
      return NextResponse.json({ error: 'לבעל צ׳יפ מסוג "אורח" נדרש שם מלא' }, { status: 400 });
    }
    const appPlatform = coerceEnum(bodyRec.app_platform, APP_PLATFORMS);
    if (!appPlatform.ok) {
      return NextResponse.json({ error: 'invalid_app_platform' }, { status: 400 });
    }
    const appInviteStatus = coerceEnum(bodyRec.app_invite_status, APP_INVITE_STATUSES);
    if (!appInviteStatus.ok) {
      return NextResponse.json({ error: 'invalid_app_invite_status' }, { status: 400 });
    }
    let holderPhone: string | null = null;
    const holderPhoneRaw = coerceText(bodyRec.holder_phone);
    if (holderPhoneRaw !== null) {
      const v = validatePhone(holderPhoneRaw);
      if (!v.valid) {
        return NextResponse.json({ error: v.error ?? 'מספר טלפון לא תקין' }, { status: 400 });
      }
      holderPhone = v.normalized;
    }
    input = legacyChipBodyToInput({
      contact_id: contactId,
      chip_type: chipTypeRaw as ChipType,
      chip_numbers: chipNumbers,
      resident_role: residentRole.value,
      holder_name: holderName,
      holder_phone: holderPhone,
      app_platform: appPlatform.value,
      app_invite_status: appInviteStatus.value,
      app_expires_at: coerceText(bodyRec.app_expires_at),
      notes: coerceText(bodyRec.notes),
    });
  }

  try {
    // The price per chip is read here, right before the save — never from the
    // request.
    const { unitPrice } = await getChipOrderSettings();
    const { items, updated, order, record } = await saveReceptionWindow(input, reception, unitPrice, {
      id: actor.id,
      name: actor.full_name ?? actor.username,
    });

    // Every reception order and every recorded payment is audited — and so is
    // a no-charge issue — INSIDE the save's own transaction
    // (saveReceptionWindow): no payment is stored without its trail.

    // "צ׳יפ חדש הונפק" → every active admin except the issuer (fire-and-forget).
    // Staff only: the orderer of a reception issue gets no message at all.
    for (const chip of items) {
      void notifyAdminsOfChipIssued(chip, chip.apartment_number, actor.id);
    }

    return NextResponse.json(
      {
        items,
        updated,
        order: order ? { id: order.id, order_number: order.order_number, total: order.total } : null,
        record: record ? { id: record.id } : null,
      },
      { status: items.length > 0 ? 201 : 200 },
    );
  } catch (err) {
    if (err instanceof ReceptionError) {
      switch (err.code) {
        case 'payment_required':
          return NextResponse.json({ error: 'יש לבחור אמצעי תשלום לצ׳יפים החדשים', code: err.code }, { status: 400 });
        case 'amount_mismatch':
          // Nothing was saved. The window shows the new sum and asks again.
          return NextResponse.json(
            {
              error: `הסכום לתשלום הוא ${formatIlsAfter(err.expectedAmount ?? 0)} — המחיר לצ׳יפ השתנה. בדקו את הסכום ושמרו שוב.`,
              code: err.code,
              expected_amount: err.expectedAmount,
            },
            { status: 409 },
          );
        case 'nothing_to_charge':
          return NextResponse.json({ error: 'אין סכום לגבייה — יש לבחור „ללא חיוב”', code: err.code }, { status: 400 });
        case 'too_many_chips':
          return NextResponse.json(
            { error: `בתשלום בקבלה אפשר להנפיק עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים בשמירה אחת`, code: err.code },
            { status: 400 },
          );
        case 'name_too_short':
          return NextResponse.json({ error: 'נדרש שם מלא (לפחות שתי אותיות) למזמין ולכל בעל צ׳יפ', code: err.code }, { status: 400 });
        case 'name_too_long':
          return NextResponse.json({ error: `שם ארוך מדי — עד ${HOLDER_NAME_MAX} תווים`, code: err.code }, { status: 400 });
        case 'lease_in_use':
          return NextResponse.json({ error: 'קובץ החוזה שייך להזמנה אחרת — יש לצרף את החוזה מחדש', code: err.code }, { status: 400 });
      }
    }
    if (err instanceof ChipNumberTakenError) {
      // group_index lets the UI mark the exact offending tag red.
      return NextResponse.json(
        {
          error: `מספר צ׳יפ ${err.chipNumber} כבר פעיל במערכת`,
          chip_number: err.chipNumber,
          group_index: err.groupIndex,
        },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === 'contact_not_found') {
      return NextResponse.json({ error: 'הדירה לא נמצאה במרשם' }, { status: 404 });
    }
    if (err instanceof Error && err.message === 'chip_not_found') {
      return NextResponse.json({ error: 'הצ׳יפ לא נמצא' }, { status: 404 });
    }
    if (err instanceof Error && err.message === 'chip_not_in_contact') {
      return NextResponse.json({ error: 'הצ׳יפ אינו שייך לדירה זו' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'invalid_chip_numbers') {
      return NextResponse.json({ error: CHIP_NUMBERS_ERROR }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'holder_name_required') {
      return NextResponse.json({ error: 'לבעל צ׳יפ מסוג "אורח" נדרש שם מלא' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'order_item_not_found') {
      return NextResponse.json({ error: 'שורת ההזמנה לא נמצאה לדירה זו' }, { status: 404 });
    }
    if (err instanceof Error && err.message === 'order_not_open') {
      return NextResponse.json({ error: 'ההזמנה כבר נאספה או נדחתה — אי אפשר לשייך לה צ׳יפים' }, { status: 409 });
    }
    if (err instanceof Error && err.message === 'holder_not_in_registry') {
      return NextResponse.json(
        { error: 'לתפקיד זה אין פרטים במרשם הדירה — השלם פרטים בדירה או בחר "אורח"' },
        { status: 422 },
      );
    }
    logger.error('[POST /api/chips]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
