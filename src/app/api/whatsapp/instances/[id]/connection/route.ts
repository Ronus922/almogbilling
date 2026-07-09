import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getInstancePublicById,
  getInstanceCredsById,
  updateInstanceState,
  type InstanceState,
} from '@/lib/db/whatsappInstances';
import {
  getInstanceState,
  getQrCode,
  logoutInstance,
  setWebhookSettings,
  WhatsAppError,
} from '@/lib/whatsapp';
import { greenWebhookUrl } from '@/lib/whatsapp-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const KNOWN_STATES: readonly InstanceState[] = [
  'notAuthorized', 'authorized', 'blocked', 'starting', 'yellowCard', 'sleepMode',
];

// Pairing/logout is instance ADMINISTRATION, gated exactly like the rest of the
// instances CRUD (requireAdmin). It is deliberately NOT gated on
// whatsapp_instances.user_id — see the note on that column in
// src/lib/db/whatsappInstances.ts; ownership is not an authorization boundary.

// GET /api/whatsapp/instances/[id]/connection — poll the live state, plus a QR
// (base64 PNG) while the instance is not yet authorized. The UI polls this every
// ~15s (Green API's QR rotates fast) until state === 'authorized'.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const instance = await getInstancePublicById(id);
  if (!instance) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });

  const creds = await getInstanceCredsById(id);
  if (!creds) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });

  let state = instance.state;
  try {
    const { stateInstance } = await getInstanceState({
      instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
    });
    if ((KNOWN_STATES as readonly string[]).includes(stateInstance)) {
      state = stateInstance as InstanceState;
      if (state !== instance.state) await updateInstanceState(id, state);
    }
  } catch {
    /* keep cached state if the probe fails */
  }

  // Only fetch a QR while not connected — Green API returns 'alreadyLogged' once up.
  let qr: string | null = null;
  if (state === 'notAuthorized' || state === 'starting') {
    const res = await getQrCode({
      instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
    });
    if (res.type === 'qrCode') qr = res.message;
    else if (res.type === 'alreadyLogged') {
      state = 'authorized';
      await updateInstanceState(id, 'authorized');
    }
  }

  return NextResponse.json({ state, qr });
}

interface PostBody {
  action?: unknown; // 'logout' | 'register'
}

// POST /api/whatsapp/instances/[id]/connection — { action: 'logout' | 'register' }.
//   logout   → disconnect the WhatsApp account (re-scan needed to reconnect).
//   register → (re-)push the inbound webhook settings to this instance.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const instance = await getInstancePublicById(id);
  if (!instance) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    /* default action */
  }
  const action = typeof body.action === 'string' ? body.action : 'logout';

  const creds = await getInstanceCredsById(id);
  if (!creds) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });

  try {
    if (action === 'register') {
      await setWebhookSettings({
        instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
        webhookUrl: greenWebhookUrl(),
      });
      return NextResponse.json({ ok: true });
    }
    // logout
    await logoutInstance({
      instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
    });
    await updateInstanceState(id, 'notAuthorized');
    return NextResponse.json({ ok: true, state: 'notAuthorized' });
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
