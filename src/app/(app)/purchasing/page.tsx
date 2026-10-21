import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { getCompany, getSequenceState, listDocuments, listPickableSuppliers } from '@/lib/db/purchasing';
import { buildProxyUrl, PURCHASING_FILES_BUCKET } from '@/lib/storage/server';
import { companyIsComplete, EMPTY_COMPANY, type DocType } from '@/lib/purchasing/model';
import { PurchasingClient } from '@/components/purchasing/PurchasingClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /purchasing — requests for quotation and purchase orders. Gate: module
// `purchasing` (super admin only by default) — the third layer on top of the
// route guards and the nav filter, exactly like /finance and /decisions.
export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'purchasing', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'purchasing', 'edit');

  const { tab } = await searchParams;
  const initialTab: DocType = tab === 'po' ? 'po' : 'rfq';

  const [rfq, po, stored, sequences, suppliers] = await Promise.all([
    listDocuments('rfq'), listDocuments('po'), getCompany(), getSequenceState(), listPickableSuppliers(),
  ]);
  const company = stored ?? EMPTY_COMPANY;

  return (
    <PurchasingClient
      initialRfq={rfq}
      initialPo={po}
      company={{
        company,
        complete: companyIsComplete(stored),
        logo_url: company.logo_key ? buildProxyUrl(PURCHASING_FILES_BUCKET, company.logo_key) : null,
        signature_url: company.signature_key ? buildProxyUrl(PURCHASING_FILES_BUCKET, company.signature_key) : null,
      }}
      sequences={sequences}
      suppliers={suppliers}
      canEdit={canEdit}
      initialTab={initialTab}
    />
  );
}
