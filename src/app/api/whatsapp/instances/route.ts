import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listUsers } from '@/lib/db/users';
import {
  listInstancesForActor,
  listInstances,
  createInstance,
  getInstanceCredsById,
  InstanceValidationError,
} from '@/lib/db/whatsappInstances';
import { setWebhookSettings, getInstanceState } from '@/lib/whatsapp';
import { updateInstanceState, type InstanceState } from '@/lib/db/whatsappInstances';
import { greenWebhookUrl, maskWebhookSecret } from '@/lib/whatsapp-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KNOWN_STATES: readonly InstanceState[] = [
  'notAuthorized', 'authorized', 'blocked', 'starting', 'yellowCard', 'sleepMode',
];

// GET /api/whatsapp/instances           → instances the actor may view (selector)
// GET /api/whatsapp/instances?manage=1   → { instances, users } for admin management
export async function GET(req: NextRequest) {
  const manage = req.nextUrl.searchParams.get('manage') === '1';

  if (manage) {
    try {
      await requireAdmin();
    } catch (err) {
      const r = authErrorResponse(err);
      if (r) return r;
      throw err;
    }
    const [instances, users] = await Promise.all([listInstances(), listUsers()]);
    return NextResponse.json({
      instances,
      users: users
        .filter((u) => u.is_active)
        .map((u) => ({ id: u.id, label: u.full_name?.trim() || u.username, role: u.role })),
    });
  }

  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json(await listInstancesForActor(actor));
}

interface PostBody {
  user_id?: unknown;
  display_name?: unknown;
  green_instance_id?: unknown;
  token?: unknown;
  api_url?: unknown;
}

// POST /api/whatsapp/instances — create an instance for an employee (admin), then
// auto-register the inbound webhook + probe the connection state.
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // The admin picks the nominal webhook owner. It labels the row and routes
  // inbound webhooks — it grants that employee nothing and denies nobody else.
  // See the header of src/lib/db/whatsappInstances.ts.
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const displayName = typeof body.display_name === 'string' ? body.display_name : '';
  const greenInstanceId = typeof body.green_instance_id === 'string' ? body.green_instance_id : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const apiUrl = typeof body.api_url === 'string' ? body.api_url : null;

  if (!userId) return NextResponse.json({ error: 'יש לבחור עובד' }, { status: 400 });

  let instance;
  try {
    instance = await createInstance({ userId, displayName, greenInstanceId, token, apiUrl });
  } catch (err) {
    if (err instanceof InstanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Auto-register the inbound webhook + probe state on the fresh instance.
  // Best-effort: a registration failure must not roll back the created instance
  // (the admin can re-register from the connection panel).
  let webhookWarning: string | undefined;
  const creds = await getInstanceCredsById(instance.id);
  if (creds) {
    try {
      await setWebhookSettings({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        webhookUrl: greenWebhookUrl(),
      });
    } catch (err) {
      webhookWarning = `החיבור נוצר אך רישום ה-webhook נכשל: ${(err as Error).message}`;
    }
    try {
      const { stateInstance } = await getInstanceState({
        instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
      });
      if ((KNOWN_STATES as readonly string[]).includes(stateInstance)) {
        await updateInstanceState(instance.id, stateInstance as InstanceState);
        instance.state = stateInstance as InstanceState;
      }
    } catch {
      /* probe is best-effort */
    }
  }

  return NextResponse.json(
    { instance, webhookUrl: maskWebhookSecret(greenWebhookUrl()), ...(webhookWarning ? { warning: webhookWarning } : {}) },
    { status: 201 },
  );
}
