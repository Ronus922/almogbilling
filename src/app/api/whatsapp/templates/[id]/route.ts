import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { updateTemplate, softDeleteTemplate } from '@/lib/db/whatsappTemplates';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  name?: unknown;
  content?: unknown;
  is_active?: unknown;
}

// PATCH /api/whatsapp/templates/[id] — edit. whatsapp_templates:edit.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('whatsapp_templates', 'edit');
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

  const patch: { name?: string; content?: string; is_active?: boolean } = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      return NextResponse.json({ error: 'שם התבנית חייב להיות באורך 1-80 תווים' }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.content !== undefined) {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length < 1 || content.length > 4096) {
      return NextResponse.json({ error: 'תוכן התבנית חייב להיות באורך 1-4096 תווים' }, { status: 400 });
    }
    patch.content = content;
  }
  if (body.is_active !== undefined) {
    patch.is_active = body.is_active === true;
  }

  const updated = await updateTemplate(id, patch);
  if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(updated);
}

// DELETE /api/whatsapp/templates/[id] — soft delete (is_active=false).
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('whatsapp_templates', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await softDeleteTemplate(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
