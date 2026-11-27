import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderSettingsBodySchema } from '@/lib/validation/requests';
import { getChipOrderSettings, updateChipOrderSettings } from '@/lib/db/appSettings';
import { cardChargingState } from '@/lib/chipOrders/cardPayment';
import { describeMorningChoice, morningStatus } from '@/lib/chipOrders/documents';
import { BUSINESS_TYPE_LABEL, DOC_TYPE_LABEL } from '@/lib/morning/documents';

export const runtime = 'nodejs';

// GET /api/settings/chip-orders — settings:view. The price rule, the texts,
// the page switch, the state of card payment (`payments`: PAYPLUS_MODE, which
// key sets are configured, the live-charging switch) and of Morning
// (`morning`: is a key configured, the business type the account reports, the
// document type that will be issued and why) — yes/no and labels only, never
// a value of a key. Read-only: none of this is changed from the screen.
export async function GET() {
  try {
    await requirePermission('settings', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json({ settings: await getChipOrderSettings(), payments: cardChargingState(), morning: await morningView() });
}

async function morningView() {
  const s = await morningStatus();
  const type = s.profile?.businessType ?? null;
  return {
    configured: s.configured,
    mode: s.mode,
    businessType: type,
    businessTypeLabel: type !== null ? (BUSINESS_TYPE_LABEL[type] ?? `סוג ${type}`) : null,
    exemption: s.profile?.exemption ?? null,
    docType: s.choice?.docType ?? null,
    docTypeLabel: s.choice?.docType ? DOC_TYPE_LABEL[s.choice.docType] : null,
    vatIncluded: s.choice?.vatIncluded ?? null,
    summary: describeMorningChoice(s),
    error: s.error,
  };
}

// PUT /api/settings/chip-orders — settings:edit.
export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const body = await parseJsonBody(req, chipOrderSettingsBodySchema);
  if (!body.ok) return body.response;
  const saved = await updateChipOrderSettings(body.data, actor.id);
  return NextResponse.json({ settings: saved, payments: cardChargingState(), morning: await morningView() });
}
