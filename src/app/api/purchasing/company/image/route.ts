import { NextResponse, type NextRequest } from 'next/server';
import { type Actor } from '@/lib/auth/actor';
import { requirePurchasingSettings } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getCompany, saveCompany } from '@/lib/db/purchasing';
import { removePurchasingObjects, uploadPurchasingObject } from '@/lib/storage/purchasingStorage';
import { isUploadError, readBrandImage } from '@/lib/purchasing/upload';
import { EMPTY_COMPANY } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Kind = 'logo' | 'signature';
const parseKind = (v: unknown): Kind | null => (v === 'logo' || v === 'signature' ? v : null);

// POST /api/purchasing/company/image — multipart { kind: logo|signature, file }.
// Replaces the previous image (its object is removed after the new one is saved).
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePurchasingSettings(); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }
  const kind = parseKind(form.get('kind'));
  const file = form.get('file');
  if (!kind) return NextResponse.json({ error: 'סוג תמונה לא תקין' }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: 'יש לצרף קובץ' }, { status: 400 });

  const read = await readBrandImage(file);
  if (isUploadError(read)) return NextResponse.json({ error: read.error }, { status: 400 });

  let uploaded: { objectKey: string };
  try { uploaded = await uploadPurchasingObject(read.bytes, read.name, read.mime); }
  catch (err) {
    logger.error('[purchasing/company/image] upload failed', err);
    return NextResponse.json({ error: 'העלאת התמונה נכשלה' }, { status: 502 });
  }

  const before = (await getCompany()) ?? EMPTY_COMPANY;
  const field = kind === 'logo' ? 'logo_key' : 'signature_key';
  const old = before[field];
  await saveCompany({ ...before, [field]: uploaded.objectKey }, actor.id);
  if (old) await removePurchasingObjects([old]);
  return NextResponse.json({ ok: true });
}

// DELETE /api/purchasing/company/image?kind=logo|signature
export async function DELETE(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePurchasingSettings(); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const kind = parseKind(req.nextUrl.searchParams.get('kind'));
  if (!kind) return NextResponse.json({ error: 'סוג תמונה לא תקין' }, { status: 400 });
  const before = (await getCompany()) ?? EMPTY_COMPANY;
  const field = kind === 'logo' ? 'logo_key' : 'signature_key';
  const old = before[field];
  await saveCompany({ ...before, [field]: null }, actor.id);
  if (old) await removePurchasingObjects([old]);
  return NextResponse.json({ ok: true });
}
