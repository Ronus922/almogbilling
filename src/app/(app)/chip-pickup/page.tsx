import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { homePathFor } from '@/lib/auth/home';
import { canHandOverChips } from '@/lib/permissions/check';
import { ChipPickupClient } from '@/components/chip-pickup/ChipPickupClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /chip-pickup — "מסירת צ׳יפים" (25/11/2026): the guard hands chips over in
// the lobby, against an ID that matches one of the people of the order. Guard,
// admin and super admin (CHIP_PICKUP_ROLES) — any other role is sent home. The
// page itself loads nothing of an order: the screen reads the narrow list of
// GET /api/chip-pickup, where the server re-asks the same question.
export default async function ChipPickupPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!canHandOverChips(actor.role)) redirect(homePathFor(actor.role));

  return <ChipPickupClient />;
}
