import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  updateInstance,
  deleteInstance,
  InstanceValidationError,
} from '@/lib/db/whatsappInstances';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  display_name?: unknown;
  green_instance_id?: unknown;
  token?: unknown;
  api_url?: unknown;
}

// PATCH /api/whatsapp/instances/[id] — edit an instance (admin).
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const updated = await updateInstance(id, {
      displayName: typeof body.display_name === 'string' ? body.display_name : undefined,
      greenInstanceId: typeof body.green_instance_id === 'string' ? body.green_instance_id : undefined,
      token: typeof body.token === 'string' ? body.token : undefined,
      apiUrl: typeof body.api_url === 'string' ? body.api_url : undefined,
    });
    if (!updated) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof InstanceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

// DELETE /api/whatsapp/instances/[id] — remove an instance (admin). Messages keep
// their history (instance_id → SET NULL).
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await deleteInstance(id);
  if (!ok) return NextResponse.json({ error: 'החיבור לא נמצא' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
