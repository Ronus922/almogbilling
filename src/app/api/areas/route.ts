import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listAreas, createArea } from '@/lib/db/areas';
import { coerceAndValidateArea } from '@/lib/validation/areas';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// GET /api/areas?search (rooms_areas:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('rooms_areas', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const search = req.nextUrl.searchParams.get('search')?.trim() || undefined;
  const areas = await listAreas(search);
  return NextResponse.json({ areas });
}

// POST /api/areas (rooms_areas:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('rooms_areas', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = coerceAndValidateArea((body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const id = await createArea(result.fields, actor.id);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    logger.error('[POST /api/areas]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
