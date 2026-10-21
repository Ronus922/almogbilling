import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { getCompany, getSequenceState, saveCompany } from '@/lib/db/purchasing';
import { writeAudit } from '@/lib/db/audit';
import { companyBodySchema } from '@/lib/validation/purchasing';
import { buildProxyUrl, PURCHASING_FILES_BUCKET } from '@/lib/storage/server';
import { companyIsComplete, EMPTY_COMPANY } from '@/lib/purchasing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/purchasing/company — the letterhead details, whether they are
// complete enough to issue a document (the wizard shows until they are), and
// the last issued number of each series (null = "ask where to start").
export async function GET() {
  try { await requirePermission('purchasing', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const company = await getCompany();
  const view = company ?? EMPTY_COMPANY;
  return NextResponse.json({
    company: view,
    complete: companyIsComplete(company),
    logo_url: view.logo_key ? buildProxyUrl(PURCHASING_FILES_BUCKET, view.logo_key) : null,
    signature_url: view.signature_key ? buildProxyUrl(PURCHASING_FILES_BUCKET, view.signature_key) : null,
    sequences: await getSequenceState(),
  });
}

// PUT /api/purchasing/company — the text fields + the VAT rate. The logo and
// the signature have their own route (multipart); their keys are preserved.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const body = await parseJsonBody(req, companyBodySchema);
  if (!body.ok) return body.response;

  const before = await getCompany();
  const next = {
    ...body.data,
    logo_key: before?.logo_key ?? null,
    signature_key: before?.signature_key ?? null,
  };
  await saveCompany(next, actor.id);
  await writeAudit({
    actorUserId: actor.id, action: 'updated', entityType: 'purchasing_company',
    changes: { before: before ? { name: before.name, vat_rate: before.vat_rate } : null, after: { name: next.name, vat_rate: next.vat_rate } },
  });
  return NextResponse.json({ company: next, complete: companyIsComplete(next) });
}
