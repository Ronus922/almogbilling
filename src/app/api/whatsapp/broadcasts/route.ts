import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getTemplateById } from '@/lib/db/whatsappTemplates';
import { listRecentBroadcasts } from '@/lib/db/whatsappBroadcasts';
import { GreenApiNotConfiguredError } from '@/lib/db/greenApiSettings';
import { startBroadcast, BroadcastValidationError } from '@/lib/whatsapp-broadcast';
import type { BroadcastAudience, BroadcastAudienceType } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/broadcasts — recent campaigns with progress (whatsapp_chat:view).
export async function GET() {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const rows = await listRecentBroadcasts();
  return NextResponse.json(rows);
}

interface PostBody {
  name?: unknown;
  body?: unknown;
  template_id?: unknown;
  audience?: unknown;
}

const AUDIENCE_TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];

function parseAudience(raw: unknown): BroadcastAudience | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (type === 'debtor_ids') {
    const ids = Array.isArray(a.debtor_ids)
      ? a.debtor_ids.filter((x): x is string => typeof x === 'string')
      : [];
    if (ids.length === 0) return null;
    return { type: 'debtor_ids', debtor_ids: ids };
  }
  if (typeof type === 'string' && (AUDIENCE_TYPES as readonly string[]).includes(type)) {
    return { type: type as BroadcastAudienceType };
  }
  return null;
}

// POST /api/whatsapp/broadcasts — create a campaign and kick off the runner.
// Body: { name, body? | template_id?, audience }. Sending = whatsapp_chat:edit.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'edit');
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
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: 'שם התפוצה חייב להיות באורך 1-80 תווים' }, { status: 400 });
  }

  const audience = parseAudience(body.audience);
  if (!audience) {
    return NextResponse.json({ error: 'קהל יעד לא תקין' }, { status: 400 });
  }

  // Resolve the message body — either a template's content or free text.
  let resolvedBody = '';
  const templateId = typeof body.template_id === 'string' ? body.template_id : '';
  if (templateId) {
    const tpl = await getTemplateById(templateId);
    if (!tpl) {
      return NextResponse.json({ error: 'התבנית לא נמצאה' }, { status: 404 });
    }
    resolvedBody = tpl.content;
  } else {
    resolvedBody = typeof body.body === 'string' ? body.body.trim() : '';
  }
  if (resolvedBody.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  if (resolvedBody.length > 4096) {
    return NextResponse.json({ error: 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' }, { status: 400 });
  }

  try {
    const broadcast = await startBroadcast({ name, body: resolvedBody, audience }, actor);
    return NextResponse.json(broadcast, { status: 201 });
  } catch (err) {
    if (err instanceof BroadcastValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GreenApiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
