import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { canPurchasing, canPurchasingSettings } from '@/lib/purchasing/access';
import { getCompany, getSequenceState, listDocuments, listPickableSuppliers } from '@/lib/db/purchasing';
import { buildProxyUrl, PURCHASING_FILES_BUCKET } from '@/lib/storage/server';
import { companyIsComplete, EMPTY_COMPANY, type DocType } from '@/lib/purchasing/model';
import { PurchasingClient } from '@/components/purchasing/PurchasingClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /purchasing — requests for quotation and purchase orders. Gate: module
// `purchasing_requests` / `purchasing_orders` (admins by role, anyone else by a
// per-user grant) — the third layer on top of the route guards and the nav
// filter. A tab the viewer cannot open is neither shown nor even queried.
export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ tab?: string; open?: string }> }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  const access = {
    rfq: { view: canPurchasing(actor, 'rfq', 'view'), edit: canPurchasing(actor, 'rfq', 'edit') },
    po: { view: canPurchasing(actor, 'po', 'view'), edit: canPurchasing(actor, 'po', 'edit') },
  };
  if (!access.rfq.view && !access.po.view) redirect('/dashboard');

  const { tab, open } = await searchParams;
  const wanted: DocType = tab === 'po' ? 'po' : 'rfq';
  const initialTab: DocType = access[wanted].view ? wanted : wanted === 'rfq' ? 'po' : 'rfq';

  const [rfq, po, stored, sequences, suppliers] = await Promise.all([
    access.rfq.view ? listDocuments('rfq') : Promise.resolve([]),
    access.po.view ? listDocuments('po') : Promise.resolve([]),
    getCompany(), getSequenceState(), listPickableSuppliers(),
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
      access={access}
      canSettings={canPurchasingSettings(actor.role)}
      initialTab={initialTab}
      initialOpenId={access.rfq.view && open && /^[0-9a-f-]{36}$/i.test(open) ? open : null}
    />
  );
}
