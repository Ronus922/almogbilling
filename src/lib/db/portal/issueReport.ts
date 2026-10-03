import 'server-only';
import { queryOne } from '@/lib/db';
import { portalIssueTitle, urgencyToPriority, type PortalIssueReport } from '@/lib/portal/issueReport';
import { resolvePortalIdentity } from '@/lib/db/portal/identity';
import type { PortalRole } from '@/lib/portal/identity';

// The owners portal's fault report, on the database side. Two rules live here:
//   • WHO reported is resolved from the session's phone only — the route
//     passes the phone of requirePortalSession(), never a value from the body;
//   • the report is an ordinary row of public.issues (source='portal'): the
//     issues screen, panel, handlers and notifications treat it like any other.

export interface PortalReporter {
  /** apartment_owner_phones.id — the phone + apartment that reported; null
   *  for an unidentified reporter (a blocked phone). */
  rosterId: string | null;
  /** null for an unidentified reporter — no apartment is claimed for them. */
  apartmentNumber: string | null;
  /** The role held in that apartment; null for an unidentified reporter. */
  role: PortalRole | null;
  name: string | null;
  phoneE164: string;
}

/**
 * The reporter behind a portal session — the PERSON whose phone was verified,
 * as the portal's one identity says (lib/portal/identity.ts): the same name
 * the header greets them by, never one worked out here.
 *
 *   • Apartment: a phone may hold several — that is normal, and never a reason
 *     to refuse: the report is about a COMMON area, the apartment only
 *     identifies the reporter. The session carries no "active apartment", so
 *     it is the lowest apartment NUMBER ('520' before '1001') the reporter
 *     owns; none → the lowest they operate; none → the lowest they rent —
 *     with that role (identity.reporter, 03/10/2026).
 *   • A BLOCKED phone: none of its apartments — and none of their names — is
 *     this reporter's. The report is still taken: "לא מזוהה", NO apartment
 *     (NULL — issues_portal_reporter_check allows it only without a roster
 *     link), no role and no roster link; the verified phone stays in
 *     reporter_phone for staff with contacts:view.
 */
export async function resolvePortalReporter(phoneE164: string): Promise<PortalReporter | null> {
  const identity = await resolvePortalIdentity(phoneE164);
  if (!identity) return null;
  const r = identity.reporter;
  return { rosterId: r.rosterId, apartmentNumber: r.apartmentNumber, role: r.role, name: r.name, phoneE164 };
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
  // NULL for an unidentified reporter — issues_portal_reporter_check
  // (migration 20261003095150) allows it only when reporter_contact_id is NULL
  // too, and demands an apartment for an identified one.
  const apartment = reporter.apartmentNumber;
  const row = await queryOne<{ id: string; ticket_number: number }>(
    `insert into public.issues
       (id, title, description, priority, status, images,
        created_by, created_by_name, source,
        reporter_contact_id, reporter_name, reporter_phone, reporter_apartment, reporter_role,
        reporter_location, reporter_area, ticket_number)
     values ($1, $2, $3, $4, 'open', $5,
             null, $6, 'portal',
             $7, $6, $8, $9, $12,
             $10, $11, nextval('public.issues_ticket_number_seq'))
     returning id, ticket_number`,
    [
      id, title, report.description, urgencyToPriority(report.urgency), images,
      reporter.name,
      reporter.rosterId, reporter.phoneE164, apartment,
      report.location, report.area,
      reporter.role,
    ],
  );
  if (!row) throw new Error('failed_to_create_portal_issue');
  return { id: row.id, title, description: report.description, ticketNumber: row.ticket_number };
}
