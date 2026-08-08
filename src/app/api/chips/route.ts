import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listChips,
  issueChip,
  ChipLimitError,
  ChipNumberTakenError,
} from '@/lib/db/chips';
import {
  CHIP_TABS,
  CHIP_TYPES,
  CHIP_STATUSES,
  CHIP_RESIDENT_ROLES,
  APP_PLATFORMS,
  APP_INVITE_STATUSES,
} from '@/lib/constants/chips';
import { validatePhone } from '@/lib/validation';
import { isSnapshotRole } from '@/lib/chips/holder';
import { createNotification } from '@/services/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import type {
  Chip,
  ChipTab,
  ChipType,
  ChipStatus,
} from '@/lib/types/chips';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHIP_NUMBERS_ERROR = 'נדרש לפחות מספר צ׳יפ אחד (עד 5)';

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
    console.error('[chips] chip_issued notification failed', err);
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

// POST /api/chips (chips:edit) — issue up to 5 chips to one contact, all-or-nothing.
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

  const chipTypeRaw = typeof bodyRec.chip_type === 'string' ? bodyRec.chip_type.trim() : '';
  if (!CHIP_TYPES.includes(chipTypeRaw as ChipType)) {
    return NextResponse.json({ error: 'invalid_chip_type' }, { status: 400 });
  }
  const chipType = chipTypeRaw as ChipType;

  const numbersRaw = bodyRec.chip_numbers;
  const chipNumbers = Array.isArray(numbersRaw)
    ? numbersRaw
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '')
    : [];
  if (chipNumbers.length === 0 || chipNumbers.length > 5) {
    return NextResponse.json({ error: CHIP_NUMBERS_ERROR }, { status: 400 });
  }

  // resident_role is REQUIRED (product rule 2 + CHECK 074) — a chip is never
  // issued without knowing on whose name it is.
  const residentRole = coerceEnum(bodyRec.resident_role, CHIP_RESIDENT_ROLES);
  if (!residentRole.ok || residentRole.value === null) {
    return NextResponse.json(
      { error: 'נדרש לבחור בעל צ׳יפ (בעל דירה / שוכר / מפעיל / אחר)' },
      { status: 400 },
    );
  }
  const holderName = coerceText(bodyRec.holder_name);
  if (isSnapshotRole(residentRole.value) && !holderName) {
    return NextResponse.json(
      { error: 'לבעל צ׳יפ מסוג "אחר" נדרש שם מלא' },
      { status: 400 },
    );
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

  let issuanceFee: number | null = null;
  if (bodyRec.issuance_fee !== undefined && bodyRec.issuance_fee !== null && bodyRec.issuance_fee !== '') {
    const fee = typeof bodyRec.issuance_fee === 'number' ? bodyRec.issuance_fee : Number.NaN;
    if (!Number.isFinite(fee) || fee < 0) {
      return NextResponse.json({ error: 'invalid_issuance_fee' }, { status: 400 });
    }
    issuanceFee = fee;
  }

  try {
    const items = await issueChip(
      {
        contact_id: contactId,
        chip_type: chipType,
        chip_numbers: chipNumbers,
        resident_role: residentRole.value,
        holder_name: holderName,
        holder_phone: holderPhone,
        app_platform: appPlatform.value,
        app_invite_status: appInviteStatus.value,
        app_expires_at: coerceText(bodyRec.app_expires_at),
        issuance_fee: issuanceFee,
        fee_charged: bodyRec.fee_charged === true,
        limit_override_reason: coerceText(bodyRec.limit_override_reason),
        notes: coerceText(bodyRec.notes),
      },
      { id: actor.id, name: actor.full_name ?? actor.username },
    );

    // "צ׳יפ חדש הונפק" → every active admin except the issuer (fire-and-forget).
    for (const chip of items) {
      void notifyAdminsOfChipIssued(chip, chip.apartment_number, actor.id);
    }

    return NextResponse.json({ items }, { status: 201 });
  } catch (err) {
    if (err instanceof ChipLimitError) {
      return NextResponse.json(
        { error: 'לדירה זו כבר מוקצים 4 צ׳יפים פעילים — נדרשת סיבת חריגה להנפקה נוספת' },
        { status: 422 },
      );
    }
    if (err instanceof ChipNumberTakenError) {
      return NextResponse.json(
        { error: `מספר צ׳יפ ${err.chipNumber} כבר פעיל במערכת` },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === 'contact_not_found') {
      return NextResponse.json({ error: 'הדירה לא נמצאה במרשם' }, { status: 404 });
    }
    if (err instanceof Error && err.message === 'invalid_chip_numbers') {
      return NextResponse.json({ error: CHIP_NUMBERS_ERROR }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'holder_name_required') {
      return NextResponse.json({ error: 'לבעל צ׳יפ מסוג "אחר" נדרש שם מלא' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'holder_not_in_registry') {
      return NextResponse.json(
        { error: 'לתפקיד זה אין פרטים במרשם הדירה — השלם פרטים בדירה או בחר "אחר"' },
        { status: 422 },
      );
    }
    console.error('[POST /api/chips]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
