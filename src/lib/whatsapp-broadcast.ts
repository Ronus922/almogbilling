import 'server-only';
import { query } from '@/lib/db';
import { insertChatMessage } from '@/lib/db/chatMessages';
import {
  createBroadcast,
  bumpBroadcastCounters,
  finishBroadcast,
} from '@/lib/db/whatsappBroadcasts';
import {
  getInstanceCredsForUser,
  type InstanceCreds,
} from '@/lib/db/whatsappInstances';
import {
  normalizePhone,
  cleanPhoneField,
  sendWhatsAppMessage,
  WhatsAppError,
} from '@/lib/whatsapp';
import { interpolateTemplate, type TemplateDebtor } from '@/lib/whatsapp-template';
import type { Actor } from '@/lib/auth/actor';
import type { Broadcast, BroadcastAudience } from '@/types/whatsapp';

// Broadcast (bulk campaign) engine. Recipients are resolved from debtors (there
// is no contacts table); the runner sends serially with a random 3–6s gap to
// avoid Green API anti-spam blocks. A single recipient's failure never stops the
// campaign. Runs fire-and-forget in the server process (same lifecycle as the
// import runner / bulk-send) — no external queue.

export class BroadcastValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastValidationError';
  }
}

interface BroadcastRecipient {
  debtor: TemplateDebtor & { id: string };
  /** International digits ("972XXXXXXXXX"). */
  phoneIntl: string;
}

interface DebtorRow {
  id: string;
  owner_name: string | null;
  tenant_name: string | null;
  apartment_number: string;
  total_debt: number;
  management_fees: number;
  special_debt: number;
  phone_owner: string | null;
  phone_tenant: string | null;
}

const DEBTOR_COLS = `
  id, owner_name, tenant_name, apartment_number,
  total_debt::float8      as total_debt,
  management_fees::float8 as management_fees,
  special_debt::float8    as special_debt,
  phone_owner, phone_tenant
`;

/** Normalise a debtor phone field to international form, or null. */
function toIntl(field: string | null): string | null {
  const local = cleanPhoneField(field);
  if (!local) return null;
  try {
    return normalizePhone(local).phone;
  } catch {
    return null;
  }
}

/**
 * Resolve the recipient list for an audience. Picks the matching phone field
 * (owners → phone_owner, tenants → phone_tenant, all/explicit → owner else
 * tenant), keeps only debtors with a valid number, and de-dups by phone.
 */
export async function resolveBroadcastRecipients(
  audience: BroadcastAudience,
): Promise<BroadcastRecipient[]> {
  let rows: DebtorRow[];
  if (audience.type === 'debtor_ids') {
    const ids = (audience.debtor_ids ?? []).filter((x) => typeof x === 'string');
    if (ids.length === 0) return [];
    const r = await query<DebtorRow>(
      `select ${DEBTOR_COLS} from public.debtors where id = any($1::uuid[])`,
      [ids],
    );
    rows = r.rows;
  } else {
    const r = await query<DebtorRow>(
      `select ${DEBTOR_COLS} from public.debtors where is_archived = false`,
    );
    rows = r.rows;
  }

  const out: BroadcastRecipient[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let phoneIntl: string | null = null;
    if (audience.type === 'owners') {
      phoneIntl = toIntl(row.phone_owner);
    } else if (audience.type === 'tenants') {
      phoneIntl = toIntl(row.phone_tenant);
    } else {
      // 'all' or 'debtor_ids' — prefer owner, fall back to tenant.
      phoneIntl = toIntl(row.phone_owner) ?? toIntl(row.phone_tenant);
    }
    if (!phoneIntl || seen.has(phoneIntl)) continue;
    seen.add(phoneIntl);
    out.push({
      debtor: {
        id: row.id,
        owner_name: row.owner_name,
        tenant_name: row.tenant_name,
        apartment_number: row.apartment_number,
        total_debt: row.total_debt,
        management_fees: row.management_fees,
        special_debt: row.special_debt,
      },
      phoneIntl,
    });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Background sender. For each recipient: interpolate the body with that debtor's
 * data, send via Green API, store a chat_messages row tagged with broadcast_id,
 * and bump the campaign counters. A 3–6s random pause separates sends.
 */
async function runBroadcast(
  broadcastId: string,
  recipients: BroadcastRecipient[],
  body: string,
  actorId: string,
  creds: InstanceCreds,
): Promise<void> {
  try {
    for (let i = 0; i < recipients.length; i++) {
      const { debtor, phoneIntl } = recipients[i];
      const message = interpolateTemplate(body, debtor);
      const chatId = `${phoneIntl}@c.us`;

      try {
        const { idMessage } = await sendWhatsAppMessage({
          instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
          chatId, message,
        });
        await insertChatMessage({
          debtorId: debtor.id,
          contactPhone: phoneIntl,
          chatId,
          externalMessageId: idMessage,
          direction: 'sent',
          content: message,
          status: 'sent',
          sentBy: actorId,
          broadcastId,
          instanceId: creds.id,
        });
        await bumpBroadcastCounters(broadcastId, { sent: 1 });
      } catch (err) {
        const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
        try {
          await insertChatMessage({
            debtorId: debtor.id,
            contactPhone: phoneIntl,
            chatId,
            externalMessageId: null,
            direction: 'sent',
            content: message,
            status: 'failed',
            errorDetail: detail,
            sentBy: actorId,
            broadcastId,
            instanceId: creds.id,
          });
        } catch (logErr) {
          console.error('[broadcast] failed to record failed row', logErr);
        }
        await bumpBroadcastCounters(broadcastId, { failed: 1 });
      }

      // Anti-ban: random 3–6s gap between sends (skip after the last one).
      if (i < recipients.length - 1) {
        await sleep(3000 + Math.floor(Math.random() * 3000));
      }
    }
    await finishBroadcast(broadcastId, 'completed');
  } catch (err) {
    console.error('[broadcast] runner crashed', err);
    try {
      await finishBroadcast(broadcastId, 'failed');
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Create a broadcast row and kick off the background runner (fire-and-forget).
 * Throws BroadcastValidationError if the resolved audience is empty. Returns the
 * created broadcast (status 'running'). The caller responds immediately; the UI
 * polls for progress.
 */
export async function startBroadcast(
  input: { name: string; body: string; audience: BroadcastAudience },
  actor: Actor,
): Promise<Broadcast> {
  // Broadcast sends through the CREATOR's own instance.
  const creds = await getInstanceCredsForUser(actor.id);

  const recipients = await resolveBroadcastRecipients(input.audience);
  if (recipients.length === 0) {
    throw new BroadcastValidationError('לא נמצאו נמענים עם מספר טלפון תקין לקהל שנבחר');
  }

  const broadcast = await createBroadcast({
    name: input.name,
    body: input.body,
    audience: input.audience,
    totalCount: recipients.length,
    createdBy: actor.id,
    instanceId: creds.id,
  });

  // Fire-and-forget — do NOT await; the request returns now and the loop runs in
  // the background of the server process.
  void runBroadcast(broadcast.id, recipients, input.body, actor.id, creds);

  return broadcast;
}
