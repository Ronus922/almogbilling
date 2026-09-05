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

export const runtime = 'nodejs';

const GMAIL_RX = /^[^\s@]+@gmail\.com$/i;

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

interface PutBody {
  fromEmail?: unknown;
  fromName?: unknown;
  password?: unknown;
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

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const fromEmail = typeof body.fromEmail === 'string' ? body.fromEmail.trim() : '';
  const fromName = typeof body.fromName === 'string' ? body.fromName.trim() : '';
  const passwordRaw = typeof body.password === 'string' ? body.password.replace(/\s+/g, '') : '';

  if (!GMAIL_RX.test(fromEmail)) {
    return NextResponse.json({ error: 'חייב להיות חשבון Gmail' }, { status: 400 });
  }
  if (fromName.length < 1 || fromName.length > 50) {
    return NextResponse.json({ error: 'שם השולח חייב להיות באורך 1-50 תווים' }, { status: 400 });
  }
  if (passwordRaw && passwordRaw.length !== 16) {
    return NextResponse.json({ error: 'App Password חייב להכיל 16 תווים' }, { status: 400 });
  }

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
