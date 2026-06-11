import { NextResponse } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getGreenApiSettingsPublic,
  updateGreenApiSettings,
  GreenApiValidationError,
} from '@/lib/db/greenApiSettings';

export const runtime = 'nodejs';

// Green API credentials — admin (and super_admin) only, same as the page they
// live on. The token is write-only: GET returns hasToken, never the value.
export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json(await getGreenApiSettingsPublic());
}

interface PutBody {
  instanceId?: unknown;
  token?: unknown;
}

export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
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

  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!/^\d{6,}$/.test(instanceId)) {
    return NextResponse.json({ error: 'מזהה Instance לא תקין (ספרות בלבד)' }, { status: 400 });
  }
  if (token && token.length < 10) {
    return NextResponse.json({ error: 'הטוקן קצר מדי' }, { status: 400 });
  }

  try {
    await updateGreenApiSettings({ instanceId, token: token || undefined }, actor.id);
  } catch (err) {
    if (err instanceof GreenApiValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[settings/green-api PUT] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
