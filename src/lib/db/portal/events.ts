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

// created_at alone is not unique (a burst of attempts can share a timestamp), and an
// unstable order across an OFFSET shows a row twice and skips another — `id` breaks the tie.
const ORDER = 'order by e.created_at desc, e.id desc';

/** The filters as a WHERE clause, shared by the list and the count so the two can never disagree. */
function whereFor(filters: PortalLogFilters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const next = () => params.length + 1;

  if (filters.apartment) {
    where.push(`$${next()} = any(e.apartment_numbers)`);
    params.push(filters.apartment);
  }
  if (filters.phone) {
    // Substring match on the digits so "0546" and "+97254" both find a number.
    where.push(`e.phone_e164 like '%' || $${next()} || '%'`);
    params.push(filters.phone);
  }
  if (filters.eventType) {
    where.push(`e.event_type = $${next()}`);
    params.push(filters.eventType);
  }
  if (filters.from) {
    where.push(`e.created_at >= $${next()}::date`);
    params.push(filters.from);
  }
  if (filters.to) {
    // Inclusive end date — the whole `to` day, not up to its midnight.
    where.push(`e.created_at < ($${next()}::date + interval '1 day')`);
    params.push(filters.to);
  }
  return { sql: where.length ? `where ${where.join(' and ')}` : '', params };
}

/**
 * The log, newest first. `apartment` narrows to one apartment (the card's tab);
 * every other filter is the admin screen's. The owner name is resolved from the
 * roster at READ time on purpose: renaming an owner fixes the whole history
 * rather than leaving old rows with a stale name.
 *
 * The first `limit` rows only (default 200) — the apartment card's tab uses this as is.
 * The admin screen pages through the whole log with {@link pagePortalEvents}.
 */
export async function listPortalEvents(filters: PortalLogFilters = {}): Promise<PortalLoginEvent[]> {
  const { sql, params } = whereFor(filters);
  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  params.push(limit);

  const r = await query<PortalLoginEvent>(
    `${SELECT}
     ${sql}
     ${ORDER}
     limit $${params.length}`,
    params,
  );
  return r.rows;
}

/**
 * One page of the log plus the TRUE number of rows the filters match (not the page's size).
 * Filtering and paging both happen in SQL — nothing is loaded just to be cut in the browser.
 * A page past the end is an empty list with the real total, so the caller can send the
 * user to the last page.
 */
export async function pagePortalEvents(
  filters: PortalLogFilters,
  page: number,
  pageSize: number,
): Promise<{ events: PortalLoginEvent[]; total: number }> {
  const { sql, params } = whereFor(filters);
  const offset = (Math.max(1, page) - 1) * pageSize;

  const [rows, count] = await Promise.all([
    query<PortalLoginEvent>(
      `${SELECT}
       ${sql}
       ${ORDER}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
    query<{ total: string }>(
      `select count(*)::text as total from public.portal_login_events e ${sql}`,
      params,
    ),
  ]);
  return { events: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
}
