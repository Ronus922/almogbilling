import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listActiveTemplates,
  listAllTemplates,
  createTemplate,
} from '@/lib/db/whatsappTemplates';

export const runtime = 'nodejs';

// GET /api/whatsapp/templates
//   default        → active templates (for the send composer)   — whatsapp:view
//   ?scope=all     → all templates (for the management screen)   — whatsapp_templates:view
export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get('scope');
  const all = scope === 'all';
  try {
    await requirePermission(all ? 'whatsapp_templates' : 'whatsapp', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const rows = all ? await listAllTemplates() : await listActiveTemplates();
  return NextResponse.json(rows);
}

interface PostBody {
  name?: unknown;
  content?: unknown;
  is_active?: unknown;
}

// POST /api/whatsapp/templates — create. Managing templates = whatsapp_templates:edit.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_templates', 'edit');
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

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const isActive = body.is_active === undefined ? true : body.is_active === true;

  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: 'שם התבנית חייב להיות באורך 1-80 תווים' }, { status: 400 });
  }
  if (content.length < 1 || content.length > 4096) {
    return NextResponse.json({ error: 'תוכן התבנית חייב להיות באורך 1-4096 תווים' }, { status: 400 });
  }

  const tpl = await createTemplate({ name, content, is_active: isActive }, actor.id);
  return NextResponse.json(tpl, { status: 201 });
}
