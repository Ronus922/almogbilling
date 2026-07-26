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

  let body: { managementFeePerSqm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const raw = body.managementFeePerSqm;
  let fee: number | null;
  if (raw === null || raw === undefined || raw === '') {
    fee = null;
  } else {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'יש להזין מחיר חיובי או להשאיר ריק' }, { status: 400 });
    }
    fee = n;
  }

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
