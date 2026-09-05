import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import type { Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  AppSettingsValidationError,
  getSmtpSettingsPublic,
  updateSmtpSettings,
} from '@/lib/db/appSettings';
import { logger } from '@/lib/logger';
import { parseJsonBody } from '@/lib/http/body';
import { smtpSettingsBodySchema } from '@/lib/validation/requests';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await requirePermission('settings', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const data = await getSmtpSettingsPublic();
  return NextResponse.json(data);
}

export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, smtpSettingsBodySchema);
  if (!body.ok) return body.response;
  const { fromEmail, fromName, password: passwordRaw } = body.data;

  try {
    await updateSmtpSettings(
      { user: fromEmail, fromName, pass: passwordRaw || undefined },
      actor.id,
    );
  } catch (err) {
    if (err instanceof AppSettingsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error('[settings/smtp PUT] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
