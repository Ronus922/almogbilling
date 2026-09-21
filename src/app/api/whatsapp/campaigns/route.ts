import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { getTemplateById } from '@/lib/db/whatsappTemplates';
import { resolveSendCreds, InstanceNotConfiguredError } from '@/lib/db/whatsappInstances';
import {
  resolveBroadcastRecipients, resolveConsolidatedBroadcastRecipients,
  resolveSelectionRecipients, resolveConsolidatedSelectionRecipients,
  parseBroadcastDebtFilter,
} from '@/lib/whatsapp-broadcast';
import {
  interpolateTemplate, interpolateBroadcastTemplate, isDebtMessageTemplate,
  templateUsesApartmentOutsideBlock, resolveConsolidatedName, sortByApartmentNumberAscending,
} from '@/lib/whatsapp-template';
import { createCampaign, listCampaigns, startCampaign, CampaignConflictError } from '@/lib/wa-queue/campaigns';
import { listStagedAttachments } from '@/lib/wa-queue/attachments';
import { campaignAttachmentIdsSchema } from '@/lib/validation/requests';
import { validateBroadcastAttachmentSet } from '@/lib/constants/whatsappAttachments';
import { withAttachmentUrls } from './_lib/attachmentUrls';
import type { BroadcastAudience, BroadcastAudienceType, BroadcastRoleSelection } from '@/types/whatsapp';
import type { RecipientInput, CampaignStatus, CampaignListFilters, CampaignListPageView } from '@/lib/wa-queue/types';

const ROLE_SELECTIONS: readonly BroadcastRoleSelection[] = ['owners', 'tenants', 'suppliers'];

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
  const page = await listCampaigns(getDbPool(), filters);
  const view: CampaignListPageView = { total: page.total, rows: page.rows.map(withAttachmentUrls) };
  return NextResponse.json(view);
}

const AUDIENCE_TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];
const INVALID_AUDIENCE_ERROR = 'קהל יעד לא תקין';
type ParsedAudience = { ok: true; audience: BroadcastAudience } | { ok: false; error: string };
function parseAudience(raw: unknown): ParsedAudience {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: INVALID_AUDIENCE_ERROR };
  const a = raw as Record<string, unknown>;
  if (a.type === 'debtor_ids') {
    const ids = Array.isArray(a.debtor_ids) ? a.debtor_ids.filter((x): x is string => typeof x === 'string') : [];
    return ids.length ? { ok: true, audience: { type: 'debtor_ids', debtor_ids: ids } } : { ok: false, error: INVALID_AUDIENCE_ERROR };
  }
  if (a.type === 'selection') {
    const roles = Array.isArray(a.roles)
      ? Array.from(new Set(a.roles.filter((x): x is BroadcastRoleSelection => (ROLE_SELECTIONS as readonly string[]).includes(x as string))))
      : [];
    if (!roles.length) return { ok: false, error: INVALID_AUDIENCE_ERROR };
    const filter = parseBroadcastDebtFilter(a.debt_filter);
    if (!filter.ok) return { ok: false, error: filter.error };
    return { ok: true, audience: { type: 'selection', roles, ...(filter.value ? { debt_filter: filter.value } : {}) } };
  }
  if (typeof a.type === 'string' && (AUDIENCE_TYPES as readonly string[]).includes(a.type))
    return { ok: true, audience: { type: a.type as BroadcastAudienceType } };
  return { ok: false, error: INVALID_AUDIENCE_ERROR };
}

// POST /api/whatsapp/campaigns — durably create + enqueue a campaign, returning
// its id IMMEDIATELY (whatsapp_chat:edit). The worker drains it out of band — the
// request never holds open for the send. Idempotent on client_token.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let body: { name?: unknown; body?: unknown; template_id?: unknown; audience?: unknown;
    dry_run?: unknown; rate_per_min?: unknown; client_token?: unknown; start?: unknown; attachment_ids?: unknown };
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

  const parsedAudience = parseAudience(body.audience);
  if (!parsedAudience.ok) return NextResponse.json({ error: parsedAudience.error }, { status: 400 });
  const audience = parsedAudience.audience;

  // Attachments: staged uploads of THIS actor, in the order given (= send order).
  // Count is zod's job; ownership + broadcast-level total size are checked here.
  const idsParsed = campaignAttachmentIdsSchema.safeParse(body.attachment_ids);
  if (!idsParsed.success) {
    return NextResponse.json({ error: idsParsed.error.issues[0]?.message ?? 'קבצים מצורפים לא תקינים', issues: idsParsed.error.issues }, { status: 400 });
  }
  const attachmentIds = Array.from(new Set(idsParsed.data));
  if (attachmentIds.length > 0) {
    const staged = await listStagedAttachments(getDbPool(), attachmentIds, actor.id);
    if (staged.length !== attachmentIds.length) {
      return NextResponse.json({ error: 'קובץ מצורף לא נמצא — הסר אותו וצרף מחדש' }, { status: 400 });
    }
    const setError = validateBroadcastAttachmentSet(staged.map((a) => ({ size: a.size_bytes })));
    if (setError) return NextResponse.json({ error: setError }, { status: 400 });
  }

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

  // Two broadcast types, auto-detected from the message content (PR ב'):
  // a free-form message (no money token) behaves EXACTLY as before this
  // feature existed — resolveBroadcastRecipients + interpolateTemplate,
  // neither touched by this branch. A debt message (any of {{debt}},
  // {{monthly}}, {{special}}, {{total_*}}, or a repeating block) is
  // consolidated: one message per phone listing every apartment it covers.
  const isDebt = isDebtMessageTemplate(messageBody);
  const isSelection = audience.type === 'selection';
  const selectionIncludesSuppliers = isSelection && (audience.roles ?? []).includes('suppliers');
  // "רק מי שחייב" / "מעל ₪" (Section 4) — owners/tenants only; suppliers are
  // never filtered, regardless of whether they're also in the selection.
  const debtFilter = isSelection ? audience.debt_filter : undefined;

  // Suppliers carry no apartment/debt data at all — a debt-message template
  // (consolidated per apartment) can never target one. Blocks the WHOLE
  // campaign at creation, same pattern as the {{apartment}}-outside-block
  // guard below: fail loudly at creation, never silently drop a recipient.
  if (isDebt && selectionIncludesSuppliers) {
    return NextResponse.json({
      error: 'לא ניתן לשלוח הודעת חוב (עם משתני חוב/דירה) לקהל שכולל ספקים — לספקים אין דירה או חוב. הסירו את "ספקים" מקהל היעד, או השתמשו בתבנית ללא משתני חוב.',
    }, { status: 400 });
  }

  let recipients: RecipientInput[];
  let partialDetailCount = 0;

  if (isDebt) {
    const consolidated = isSelection
      ? await resolveConsolidatedSelectionRecipients(audience.roles ?? [], debtFilter)
      : await resolveConsolidatedBroadcastRecipients(audience);
    if (consolidated.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });

    // Hard block: {{apartment}} outside the repeating block is ambiguous for
    // any recipient holding more than one apartment — blocks the WHOLE
    // campaign at creation time (not a silent per-recipient skip at send).
    if (templateUsesApartmentOutsideBlock(messageBody)) {
      const affected = consolidated.filter((r) => r.apartments.length > 1).length;
      if (affected > 0) {
        return NextResponse.json({
          error: `התבנית משתמשת ב-{{apartment}} מחוץ לקטע החוזר, ו-${affected} נמענים מחזיקים יותר מדירה אחת — לא ברור איזו דירה להציג. עטפו את החלק שחוזר לכל דירה ב-{{#apartments}}...{{/apartments}}.`,
        }, { status: 400 });
      }
    }

    recipients = consolidated.map((r) => {
      const apartments = sortByApartmentNumberAscending(r.apartments);
      const rep = apartments[0];
      const rendered = interpolateBroadcastTemplate(messageBody, {
        name: resolveConsolidatedName(r.rawNames),
        apartments,
      });
      if (rendered.truncated) partialDetailCount += 1;
      return {
        contactId: rep.contactId,
        debtorId: rep.debtorId,
        phoneIntl: r.phoneIntl,
        payload: rendered.text,
        apartments: apartments.map((a) => ({ contactId: a.contactId, debtorId: a.debtorId })),
      };
    });
  } else if (isSelection) {
    const resolved = await resolveSelectionRecipients(audience.roles ?? [], debtFilter);
    if (resolved.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });
    recipients = resolved.map((r) => r.kind === 'supplier'
      ? {
          contactId: null, debtorId: null, supplierId: r.supplierId, phoneIntl: r.phoneIntl,
          payload: interpolateTemplate(messageBody, {
            owner_name: r.name, tenant_name: null, apartment_number: null,
            total_debt: null, management_fees: null, hot_water_debt: null,
          }),
        }
      : {
          contactId: r.contactId, debtorId: r.debtorId, phoneIntl: r.phoneIntl,
          payload: interpolateTemplate(messageBody, r.debtor),
        });
  } else {
    const resolved = await resolveBroadcastRecipients(audience);
    if (resolved.length === 0) return NextResponse.json({ error: 'לא נמצאו נמענים עם מספר תקין' }, { status: 400 });
    recipients = resolved.map((r) => ({
      contactId: r.contactId, debtorId: r.debtorId, phoneIntl: r.phoneIntl,
      payload: interpolateTemplate(messageBody, r.debtor),
    }));
  }

  let campaign;
  try {
    campaign = await createCampaign(getDbPool(), {
      name, body: messageBody, templateName, audience, instanceId, createdBy: actor.id, recipients,
      ratePerMin: typeof body.rate_per_min === 'number' ? body.rate_per_min : undefined,
      dryRun,
      clientToken: typeof body.client_token === 'string' ? body.client_token : null,
      attachmentIds,
    });
  } catch (err) {
    if (err instanceof CampaignConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }

  // Default: start immediately (durably). Pass start:false to stage as 'queued'.
  const started = body.start === false ? campaign : await startCampaign(getDbPool(), campaign.id);
  // partial_detail_count: how many recipients' consolidated apartment list was
  // cut short by the truncation budget (interpolateBroadcastTemplate) — 0 for
  // a free-form campaign. Computed here, not stored, so it needs no schema
  // change; surfaced to the operator via the compose screen's success toast.
  return NextResponse.json({ ...started, partial_detail_count: partialDetailCount }, { status: 201 });
}
