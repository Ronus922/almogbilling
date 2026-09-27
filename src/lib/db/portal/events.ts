import 'server-only';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { PortalEventType } from '@/lib/constants/portal';
import type { PortalLoginEvent, PortalLogFilters } from '@/lib/types/portal';

// The login log (portal_login_events). Every attempt is recorded, including
// attempts from a phone that is not on the roster — those keep an empty
// apartment_numbers and the screens show "—".
//
// NEVER put the code in `details`. The column exists for context a human needs
// when reading the log (which tier a lockout was, why a send failed); the digits
// are not context, they are the secret.

export interface LogEventInput {
  phoneE164: string;
  eventType: PortalEventType;
  apartmentNumbers?: string[];
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

/** Best-effort, exactly like writeAudit: a log failure must never break a login
 *  or leak a pg error to the resident. */
export async function logPortalEvent(input: LogEventInput): Promise<void> {
  try {
    await query(
      `insert into public.portal_login_events
         (phone_e164, apartment_numbers, event_type, ip, user_agent, details)
       values ($1, $2::text[], $3, $4, $5, $6::jsonb)`,
      [
        input.phoneE164,
        input.apartmentNumbers ?? [],
        input.eventType,
        input.ip ?? null,
        input.userAgent ?? null,
        input.details != null ? JSON.stringify(input.details) : null,
      ],
    );
  } catch (err) {
    logger.error('[portal] failed to record login event', {
      eventType: input.eventType,
      err,
    });
  }
}

const SELECT = `
  select e.id, e.phone_e164, e.apartment_numbers, e.event_type, e.ip, e.user_agent,
         e.created_at,
         (select o.owner_name
            from public.apartment_owner_phones o
           where o.phone_e164 = e.phone_e164 and o.owner_name is not null
           order by o.is_active desc, o.created_at
           limit 1) as owner_name
    from public.portal_login_events e`;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * The log, newest first. `apartment` narrows to one apartment (the card's tab);
 * every other filter is the admin screen's. The owner name is resolved from the
 * roster at READ time on purpose: renaming an owner fixes the whole history
 * rather than leaving old rows with a stale name.
 */
export async function listPortalEvents(filters: PortalLogFilters = {}): Promise<PortalLoginEvent[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let n = 1;

  if (filters.apartment) {
    where.push(`$${n++} = any(e.apartment_numbers)`);
    params.push(filters.apartment);
  }
  if (filters.phone) {
    // Substring match on the digits so "0546" and "+97254" both find a number.
    where.push(`e.phone_e164 like '%' || $${n++} || '%'`);
    params.push(filters.phone);
  }
  if (filters.eventType) {
    where.push(`e.event_type = $${n++}`);
    params.push(filters.eventType);
  }
  if (filters.from) {
    where.push(`e.created_at >= $${n++}::date`);
    params.push(filters.from);
  }
  if (filters.to) {
    // Inclusive end date — the whole `to` day, not up to its midnight.
    where.push(`e.created_at < ($${n++}::date + interval '1 day')`);
    params.push(filters.to);
  }

  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  params.push(limit);

  const r = await query<PortalLoginEvent>(
    `${SELECT}
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by e.created_at desc
     limit $${n}`,
    params,
  );
  return r.rows;
}
