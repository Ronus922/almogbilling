import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { isElevatedRole } from '@/lib/permissions/constants';
import { hasPermission } from '@/lib/permissions/check';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { listReceptionRecords } from '@/lib/db/chipReception';
import type { ReceptionContext } from '@/lib/chipOrders/reception';
import { liveCardConfig, testCardConfig } from '@/lib/chipOrders/cardPayment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/chips/reception?contact_id= (chips:edit — the permission of the
// issue window itself) — what "הנפק צ׳יפ" needs besides the apartment's chips:
//   · the price per chip of /settings (the payment section shows chips × it;
//     the save computes the amount again on the server);
//   · whether "אשראי" is drawn at all — admin and super admin only. It is
//     decided HERE, by role, so every way into the window gets the same answer
//     and no other role ever receives the option — and whether it charges for
//     real (live charging armed) or can be tried in the sandbox (26/11/2026);
//   · whether the viewer may open a lease (the rule of the lease bucket);
//   · the reception saves the apartment's chips came from (no-charge records
//     and reception orders), which a holder block shows again.
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const contactId = req.nextUrl.searchParams.get('contact_id')?.trim() ?? '';
  if (contactId && !UUID_RE.test(contactId)) {
    return NextResponse.json({ error: 'invalid_contact_id' }, { status: 400 });
  }
  const [settings, records] = await Promise.all([
    getChipOrderSettings(),
    contactId ? listReceptionRecords(contactId) : Promise.resolve([]),
  ]);
  const body: ReceptionContext = {
    unit_price: settings.unitPrice,
    card_option: isElevatedRole(actor.role),
    card_live: isElevatedRole(actor.role) && liveCardConfig() !== null,
    card_test: isElevatedRole(actor.role) && testCardConfig() !== null,
    lease_view: hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'view'),
    records,
  };
  return NextResponse.json(body);
}
