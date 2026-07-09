import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { getTemplateById } from '@/lib/db/whatsappTemplates';
import { resolveSendCreds, InstanceNotConfiguredError } from '@/lib/db/whatsappInstances';
import { resolveBroadcastRecipients } from '@/lib/whatsapp-broadcast';
import { interpolateTemplate } from '@/lib/whatsapp-template';
import { createCampaign, listCampaigns, startCampaign } from '@/lib/wa-queue/campaigns';
import type { BroadcastAudience, BroadcastAudienceType } from '@/types/whatsapp';
import type { RecipientInput, CampaignStatus, CampaignListFilters } from '@/lib/wa-queue/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft', 'queued', 'running', 'paused', 'completed',
  'completed_with_errors', 'cancelled', 'failed',
];

// GET /api/whatsapp/campaigns — history page: newest-first, filterable by status /
// name search / date range, paginated (whatsapp_chat:view). Returns { rows, total }.
export async function GET(req: NextRequest) {
  try { await requirePermission('whatsapp_chat', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const sp = req.nextUrl.searchParams;
  const statusParam = sp.get('status');
  const filters: CampaignListFilters = {
    status: statusParam && (CAMPAIGN_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as CampaignStatus) : undefined,
    q: sp.get('q')?.trim() || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
    offset: sp.get('offset') ? Number(sp.get('offset')) : undefined,
  };
  return NextResponse.json(await listCampaigns(getDbPool(), filters));
}

const AUDIENCE_TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];
function parseAudience(raw: unknown): BroadcastAudience | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.type === 'debtor_ids') {
    const ids = Array.isArray(a.debtor_ids) ? a.debtor_ids.filter((x): x is string => typeof x === 'string') : [];
    return ids.length ? { type: 'debtor_ids', debtor_ids: ids } : null;
  }
  if (typeof a.type === 'string' && (AUDIENCE_TYPES as readonly string[]).includes(a.type))
    return { type: a.type as BroadcastAudienceType };
  return null;
}

// POST /api/whatsapp/campaigns — durably create + enqueue a campaign, returning
// its id IMMEDIATELY (whatsapp_chat:edit). The worker drains it out of band — the
// request never holds open for the send. Idempotent on client_token.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let body: { name?: unknown; body?: unknown; template_id?: unknown; audience?: unknown;
    dry_run?: unknown; rate_per_min?: unknown; client_token?: unknown; start?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'שם קמפיין חסר' }, { status: 400 });

  let messageBody = typeof body.body === 'string' ? body.body : '';
  let templateName: string | null = null;
  if (typeof body.template_id === 'string' && body.template_id) {
    const tpl = await getTemplateById(body.template_id);
    if (!tpl) return NextResponse.json({ error: 'התבנית לא נמצאה' }, { status: 400 });
    templateName = tpl.name;                 // snapshot the name — survives later edit/delete
    if (!messageBody) messageBody = tpl.content;
  }
  if (!messageBody.trim()) return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });

  const audience = parseAudience(body.audience);
  if (!audience) return NextResponse.json({ error: 'קהל יעד לא תקין' }, { status: 400 });

  const dryRun = body.dry_run === true;
  let instanceId: string | null = null;
  try {
    // dry-run needs no real instance; real sends resolve like chat-send does
    // (own instance, admin falls back to the first connected one).
    if (!dryRun) instanceId = (await resolveSendCreds(actor, null)).id;
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }

  const resolved = await resolveBroadcastRecipients(audience);
  if (resolved.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });
  const recipients: RecipientInput[] = resolved.map((r) => ({
    debtorId: r.debtor.id, phoneIntl: r.phoneIntl, payload: interpolateTemplate(messageBody, r.debtor),
  }));

  const campaign = await createCampaign(getDbPool(), {
    name, body: messageBody, templateName, audience, instanceId, createdBy: actor.id, recipients,
    ratePerMin: typeof body.rate_per_min === 'number' ? body.rate_per_min : undefined,
    dryRun,
    clientToken: typeof body.client_token === 'string' ? body.client_token : null,
  });

  // Default: start immediately (durably). Pass start:false to stage as 'queued'.
  const started = body.start === false ? campaign : await startCampaign(getDbPool(), campaign.id);
  return NextResponse.json(started, { status: 201 });
}
