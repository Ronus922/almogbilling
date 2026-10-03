// Usage:
//   node scripts/portal/roster-detach.mjs <batch.tsv>           # DRY-RUN — checks every row, writes nothing
//   node scripts/portal/roster-detach.mjs <batch.tsv> --apply   # one transaction: switch off + log, or nothing
//
// The approved clean-up of the portal roster (audit 03/10/2026, Ronen's
// "מאושר" — the batches live in reports/, local only, they hold phones). Each
// line of the batch: <roster id> TAB <apartment> TAB <phone E.164> TAB <reason>.
// Lines starting with '#' are comments.
//
// Per row, all inside ONE transaction (any surprise rolls the whole batch back):
//   • the row must exist with exactly that apartment and phone — the batch was
//     built from a read-only snapshot, and a row that changed since is not ours
//     to touch any more;
//   • already off → skipped (the roster sync may have got there first);
//   • a phone some owner record STILL carries is DETACHED (detach_reason
//     'audit_2026_10'): the sync will not re-link it while the record holds it
//     — the record itself is fixed by hand (see the end-of-task report);
//   • a phone no record carries is just switched off — nothing would re-link it;
//   • every change → one audit_log row: action portal_owner_phone_detached,
//     reason audit_2026_10, the reason text from the batch, the batch name.
// Nothing is deleted. Sessions are not touched: every portal request re-checks
// the roster (isActiveOwner), so a phone left with nothing is out on its next
// request, and a phone that keeps other apartments sees only those.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/portal/roster-detach.mjs <batch.tsv> [--apply]');
  process.exit(2);
}
const connectionString = process.env.ROSTER_DB_URL;
if (!connectionString) {
  console.error('ROSTER_DB_URL is not set (the DIRECT_URL of the target database, with sslmode)');
  process.exit(2);
}

const batch = basename(file);
const rows = readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l, i) => {
    const [id, apartment, phone, reason] = l.split('\t');
    if (!id || !apartment || !phone || !reason) throw new Error(`line ${i + 1}: expected 4 tab-separated fields`);
    return { id, apartment, phone, reason };
  });

const client = new pg.Client({ connectionString });
// The session pooler answers a disconnect with a FATAL "db_termination"; with
// no listener that arrives as an unhandled 'error' AFTER the work is done.
// A real failure mid-batch still surfaces: it rejects the awaited query.
client.on('error', () => {});
await client.connect();
const out = { detached: 0, switchedOff: 0, skipped: 0 };
try {
  await client.query('begin');
  for (const r of rows) {
    const cur = await client.query(
      `select id, apartment_number, phone_e164, owner_name, is_active, source_table
         from public.apartment_owner_phones where id = $1 for update`,
      [r.id],
    );
    const row = cur.rows[0];
    if (!row) throw new Error(`${r.id}: no such roster row`);
    if (row.apartment_number !== r.apartment || row.phone_e164 !== r.phone) {
      throw new Error(`${r.id}: changed since the snapshot (now ${row.apartment_number} / ${row.phone_e164})`);
    }
    if (!row.is_active) { out.skipped += 1; continue; }

    const sticky = row.source_table !== null;
    await client.query(
      sticky
        ? `update public.apartment_owner_phones
              set is_active = false, detached_at = now(), detach_reason = 'audit_2026_10'
            where id = $1`
        : `update public.apartment_owner_phones set is_active = false where id = $1`,
      [r.id],
    );
    await client.query(
      `insert into public.audit_log (action, entity_type, entity_id, metadata)
       values ('portal_owner_phone_detached', 'apartment_owner_phone', $1, $2)`,
      [r.id, JSON.stringify({
        apartment_number: row.apartment_number,
        phone_e164: row.phone_e164,
        owner_name: row.owner_name,
        reason: 'audit_2026_10',
        detail: r.reason,
        sticky,
        batch,
        approved: 'רונן — "מאושר" 03/10/2026',
        via: 'scripts/portal/roster-detach.mjs',
      })],
    );
    if (sticky) out.detached += 1; else out.switchedOff += 1;
  }
  await client.query(APPLY ? 'commit' : 'rollback');
  console.log(JSON.stringify({ batch, mode: APPLY ? 'APPLIED' : 'DRY-RUN (rolled back)', rows: rows.length, ...out }));
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`ROLLED BACK — nothing changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
