import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  AppSettingsValidationError,
  getBillingSettings,
  recomputeAllManagementFees,
  updateBillingSettings,
} from '@/lib/db/appSettings';
import { getSession } from '@/lib/auth/session';
import { parseJsonBody } from '@/lib/http/body';
import { billingSettingsBodySchema } from '@/lib/validation/requests';

export const runtime = 'nodejs';

// GET /api/settings/billing — any authenticated user. The apartment card needs
// the per-m² rate to show the derived management fee, and its editors do not
// necessarily hold settings:view. The value is a public price, not a secret;
// writing it still requires settings:edit (PUT below).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await getBillingSettings());
}

// PUT /api/settings/billing — settings:edit. '' / null clears the rate.
export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, billingSettingsBodySchema);
  if (!body.ok) return body.response;
  const fee = body.data.managementFeePerSqm;

  let recomputed = 0;
  try {
    await updateBillingSettings({ managementFeePerSqm: fee }, actor.id);
    // The fee is derived from the rate, so every apartment with a size is
    // re-derived here — otherwise old fees would survive a rate change.
    recomputed = await recomputeAllManagementFees(fee);
  } catch (err) {
    if (err instanceof AppSettingsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ managementFeePerSqm: fee, recomputed });
}
