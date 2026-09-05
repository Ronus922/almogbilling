import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  AppSettingsValidationError,
  getLegalContact,
  updateLegalContact,
} from '@/lib/db/appSettings';
import type { LegalContactErrors } from '@/lib/validation/legalContact';
import { legalContactBodySchema } from '@/lib/validation/requests';

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = legalContactBodySchema.safeParse(raw);
  if (!parsed.success) {
    // Same 400 shape as before (error + per-field errors) with zod's issues added.
    const errors: LegalContactErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'email' || field === 'name') errors[field] = issue.message;
    }
    return NextResponse.json(
      { error: errors.email ?? errors.name ?? 'קלט לא תקין', errors, issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const saved = await updateLegalContact(parsed.data, actor.id);
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof AppSettingsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
