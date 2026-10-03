import 'server-only';
import { queryOne } from '@/lib/db';
import { portalIssueTitle, urgencyToPriority, type PortalIssueReport } from '@/lib/portal/issueReport';

// The owners portal's fault report, on the database side. Two rules live here:
//   • WHO reported is resolved from the session's phone only — the route
//     passes the phone of requirePortalSession(), never a value from the body;
//   • the report is an ordinary row of public.issues (source='portal'): the
//     issues screen, panel, handlers and notifications treat it like any other.

export interface PortalReporter {
  /** apartment_owner_phones.id — the phone + apartment that signed in. */
  rosterId: string;
  apartmentNumber: string;
  name: string | null;
  phoneE164: string;
}

/**
 * The reporter behind a portal session. A phone may own several apartments —
 * that is normal (68 phones on 03/10/2026) and never a reason to refuse: the
 * report is about a COMMON area, the apartment only identifies the reporter.
 * The session carries no "active apartment", so the rule is the lowest
 * apartment NUMBER — compared as a number ('520' before '1001'), not as text,
 * where '1001' < '520'. A non-numeric apartment (none exist in production)
 * sorts after every numeric one, then as text, so the choice stays
 * deterministic. The name is that roster row's; when it has none, the same
 * phone's name on another of its rows (it is the same person).
 */
export async function resolvePortalReporter(phoneE164: string): Promise<PortalReporter | null> {
  const row = await queryOne<{ id: string; apartment_number: string; phone_e164: string; name: string | null }>(
    `select r.id, r.apartment_number, r.phone_e164,
            coalesce(
              nullif(btrim(r.owner_name), ''),
              (select nullif(btrim(o.owner_name), '')
                 from public.apartment_owner_phones o
                where o.phone_e164 = r.phone_e164 and o.is_active
                  and nullif(btrim(o.owner_name), '') is not null
                order by o.created_at, o.id
                limit 1)
            ) as name
       from public.apartment_owner_phones r
      where r.phone_e164 = $1 and r.is_active
      order by (r.apartment_number ~ '^[0-9]+$') desc,
               case when r.apartment_number ~ '^[0-9]+$' then r.apartment_number::numeric end asc,
               r.apartment_number asc,
               r.id asc
      limit 1`,
    [phoneE164],
  );
  if (!row) return null;
  return { rosterId: row.id, apartmentNumber: row.apartment_number, name: row.name, phoneE164: row.phone_e164 };
}

export interface CreatedPortalIssue {
  id: string;
  title: string;
  description: string;
  ticketNumber: number;
}

/**
 * Insert the report as one statement — the row appears complete or not at
 * all. `id` is chosen by the caller, because the photos are uploaded under
 * `<issueId>/` BEFORE the row exists (so no half-made issue is ever visible to
 * staff); `images` are those object paths. status 'open', no handler (it lands
 * in "ממתין לשיוך"), created_by NULL (no users row — the reporter is the
 * snapshot), and the call number from its own sequence.
 */
export async function insertPortalIssue(args: {
  id: string;
  report: PortalIssueReport;
  reporter: PortalReporter;
  images: string[];
}): Promise<CreatedPortalIssue> {
  const { id, report, reporter, images } = args;
  const title = portalIssueTitle(report.location);
  const row = await queryOne<{ id: string; ticket_number: number }>(
    `insert into public.issues
       (id, title, description, priority, status, images,
        created_by, created_by_name, source,
        reporter_contact_id, reporter_name, reporter_phone, reporter_apartment,
        reporter_location, reporter_area, ticket_number)
     values ($1, $2, $3, $4, 'open', $5,
             null, $6, 'portal',
             $7, $6, $8, $9,
             $10, $11, nextval('public.issues_ticket_number_seq'))
     returning id, ticket_number`,
    [
      id, title, report.description, urgencyToPriority(report.urgency), images,
      reporter.name,
      reporter.rosterId, reporter.phoneE164, reporter.apartmentNumber,
      report.location, report.area,
    ],
  );
  if (!row) throw new Error('failed_to_create_portal_issue');
  return { id: row.id, title, description: report.description, ticketNumber: row.ticket_number };
}
