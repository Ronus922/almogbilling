import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { deactivateChip, ChipStateError } from '@/lib/db/chips';
import { CHIP_DEACTIVATION_REASONS, DEACTIVATION_REASON_LABEL } from '@/lib/constants/chips';
import { createNotification } from '@/services/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import type { Chip, ChipDeactivationReason } from '@/lib/types/chips';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * Notify every active admin (super_admin + admin) — except the actor — that a
 * chip was deactivated as lost/stolen. Best-effort, deduped per (chip, admin);
 * never throws (fire-and-forget after the chip is already persisted).
 */
async function notifyAdminsOfChipLost(chip: Chip, actorId: string): Promise<void> {
  try {
    const reasonLabel = chip.deactivation_reason
      ? DEACTIVATION_REASON_LABEL[chip.deactivation_reason]
      : '';
    const message = `צ׳יפ ${chip.chip_number} (דירה ${chip.apartment_number}) הושבת — ${reasonLabel}`;
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      if (admin.id === actorId) continue;
      await createNotification({
        userId: admin.id,
        type: 'chip_deactivated_lost',
        title: 'צ׳יפ הושבת — אבד או נגנב',
        message,
        sourceModule: 'chips',
        sourceEntityType: 'chip',
        sourceEntityId: chip.id,
        actionUrl: `/chips?chip=${chip.id}`,
        priority: 'high',
        dedupeKey: `chip_deactivated_lost:${chip.id}:${admin.id}`,
      });
    }
  } catch (err) {
    console.error('[chips] chip_deactivated_lost notification failed', err);
  }
}

// POST /api/chips/[id]/deactivate (chips:edit) — active -> inactive.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const reasonRaw = typeof bodyRec.reason === 'string' ? bodyRec.reason.trim() : '';
  if (!CHIP_DEACTIVATION_REASONS.includes(reasonRaw as ChipDeactivationReason)) {
    return NextResponse.json({ error: 'נדרשת סיבת השבתה' }, { status: 400 });
  }
  const reason = reasonRaw as ChipDeactivationReason;

  const noteRaw = typeof bodyRec.note === 'string' ? bodyRec.note.trim() : '';
  const note = noteRaw !== '' ? noteRaw : null;
  const controllerSynced = bodyRec.controller_synced === true;

  try {
    const chip = await deactivateChip(
      id,
      { reason, note, controllerSynced },
      { id: actor.id, name: actor.full_name ?? actor.username },
    );
    if (!chip) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // "צ׳יפ אבד או נגנב" → every active admin except the actor (fire-and-forget).
    if (reason === 'lost' || reason === 'stolen') {
      void notifyAdminsOfChipLost(chip, actor.id);
    }

    return NextResponse.json({ chip });
  } catch (err) {
    if (err instanceof ChipStateError) {
      return NextResponse.json({ error: 'הצ׳יפ כבר מושבת' }, { status: 409 });
    }
    console.error('[POST /api/chips/:id/deactivate]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
