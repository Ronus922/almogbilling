import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listApartmentNumbers } from '@/lib/db/contacts';
import { listParkingSpots, listStorageUnits } from '@/lib/db/parking';
import { DEFAULT_LOT_CODE } from '@/lib/constants/parking';
import { ParkingPageClient } from './parking-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ParkingPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'parking', 'view')) {
    redirect('/dashboard');
  }
  // Without parking:edit the table still shows the whole allocation — it just
  // stops being a control: no hover, no cell opens.
  const canEdit = hasPermission(actor.role, actor.permissions, 'parking', 'edit');

  const [apartments, spots, units] = await Promise.all([
    listApartmentNumbers(),
    listParkingSpots({ lot_code: DEFAULT_LOT_CODE }),
    listStorageUnits({}),
  ]);

  return (
    <ParkingPageClient
      apartments={apartments}
      initialSpots={spots}
      initialUnits={units}
      canEdit={canEdit}
    />
  );
}
