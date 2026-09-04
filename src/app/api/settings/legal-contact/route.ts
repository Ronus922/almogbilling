import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  AppSettingsValidationError,
  getLegalContact,
  updateLegalContact,
} from '@/lib/db/appSettings';
import { normalizeLegalContact } from '@/lib/validation/legalContact';

export const runtime = 'nodejs';

// GET /api/settings/legal-contact — settings:view.
export async function GET() {
  try {
    await requirePermission('settings', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json(await getLegalContact());
}

// PUT /api/settings/legal-contact — settings:edit. Both fields may be ''
// (clears the contact — nothing is sent to the lawyer); a non-empty email
// must be well-formed. Responds with the stored value.
export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: { email?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const normalized = normalizeLegalContact(body);
  if (!normalized.ok) {
    return NextResponse.json(
      { error: normalized.errors.email ?? normalized.errors.name ?? 'קלט לא תקין', errors: normalized.errors },
      { status: 400 },
    );
  }

  try {
    const saved = await updateLegalContact(normalized.value, actor.id);
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof AppSettingsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
