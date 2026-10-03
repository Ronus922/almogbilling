// Usage:
//   node scripts/portal/issue-reporter-fix.mjs <ticket> <apartment> <role>           # DRY-RUN — prints, writes nothing
//   node scripts/portal/issue-reporter-fix.mjs <ticket> <apartment> <role> --apply   # one transaction: fix + log, or nothing
//
// Re-identify ONE portal fault report recorded as "לא מזוהה" (approved
// 03/10/2026 for #1002: Ronen's report from 10:31 UTC, made while his phone was
// still blocked by the containment; since the clean-up of 03/10/2026 the same
// phone opens only 1210, as owner).
//
// Nothing is guessed. The report's OWN verified phone (issues.reporter_phone)
// must hold an ACTIVE link to exactly that apartment in exactly that role, and
// that must be its only active apartment (so the phone is one person by the
// portal's own rule — no approval needed, nothing to compare). The snapshot
// then gets what the portal would write today: the roster link, the name on
// it, the apartment and the role. One audit_log row with before and after.
// Idempotent: a report already carrying that link is left alone.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const [ticketArg, apartment, role] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ticket = Number(ticketArg);
if (!Number.isInteger(ticket) || !apartment || !['owner', 'tenant', 'operator'].includes(role ?? '')) {
  console.error('usage: node scripts/portal/issue-reporter-fix.mjs <ticket> <apartment> <owner|tenant|operator> [--apply]');
  process.exit(2);
}
const connectionString = process.env.ROSTER_DB_URL;
if (!connectionString) {
  console.error('ROSTER_DB_URL is not set (the DIRECT_URL of the target database, with sslmode)');
  process.exit(2);
}

const client = new pg.Client({ connectionString });
// The session pooler answers a disconnect with a FATAL "db_termination"; with
// no listener that arrives as an unhandled 'error' AFTER the work is done.
client.on('error', () => {});
await client.connect();
try {
  await client.query('begin');
  const issue = (await client.query(
    `select id, source, reporter_contact_id, reporter_name, created_by_name, reporter_phone,
            reporter_apartment, reporter_role
       from public.issues where ticket_number = $1
       for update`,
    [ticket],
  )).rows[0];
  if (!issue) throw new Error(`no issue with ticket ${ticket}`);
  if (issue.source !== 'portal') throw new Error(`ticket ${ticket} is not a portal report`);
  if (!issue.reporter_phone) throw new Error(`ticket ${ticket} has no verified reporter phone`);

  const links = (await client.query(
    `select id, apartment_number, role, owner_name from public.apartment_owner_phones
      where phone_e164 = $1 and is_active`,
    [issue.reporter_phone],
  )).rows;
  if (links.length !== 1) throw new Error(`the reporter phone holds ${links.length} active links — expected exactly one`);
  const link = links[0];
  if (link.apartment_number !== apartment || link.role !== role) {
    throw new Error(`the reporter phone's active link is apartment ${link.apartment_number} as ${link.role}, not ${apartment} as ${role}`);
  }
  const name = (link.owner_name ?? '').trim().replace(/\s+/g, ' ') || null;

  const done = issue.reporter_contact_id === link.id && issue.reporter_apartment === apartment && issue.reporter_role === role;
  if (done) console.log(`ticket ${ticket}: already ${apartment} / ${role} — nothing to do`);

  if (!done) {
    const before = {
      reporter_contact_id: issue.reporter_contact_id, reporter_name: issue.reporter_name,
      created_by_name: issue.created_by_name, reporter_apartment: issue.reporter_apartment,
      reporter_role: issue.reporter_role,
    };
    const after = {
      reporter_contact_id: link.id, reporter_name: name, created_by_name: name,
      reporter_apartment: apartment, reporter_role: role,
    };
    console.log(`ticket ${ticket}:`, JSON.stringify(before), '→', JSON.stringify(after));

    await client.query(
      `update public.issues
          set reporter_contact_id = $2, reporter_name = $3, created_by_name = $3,
              reporter_apartment = $4, reporter_role = $5
        where id = $1`,
      [issue.id, link.id, name, apartment, role],
    );
    await client.query(
      `insert into public.audit_log (action, entity_type, entity_id, metadata)
       values ('issue_portal_reporter_identified', 'issue', $1, $2::jsonb)`,
      [issue.id, JSON.stringify({
        ticket_number: ticket, before, after,
        reason: 'reported while the phone was blocked; the phone is one person since the clean-up of 03/10/2026',
        approved: '03/10/2026', via: 'scripts/portal/issue-reporter-fix.mjs',
      })],
    );
  }

  if (APPLY && !done) {
    await client.query('commit');
    console.log('APPLIED');
  } else {
    await client.query('rollback');
    if (!done) console.log('DRY-RUN — rolled back; run again with --apply');
  }
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`FAILED — nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
