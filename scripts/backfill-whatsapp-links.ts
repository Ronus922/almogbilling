// Usage:
//   npx tsx scripts/backfill-whatsapp-links.ts          # DRY-RUN (reports, writes nothing)
//   npx tsx scripts/backfill-whatsapp-links.ts --apply  # link + report
//
// One-shot relink of existing WhatsApp conversations to debtors using the
// normalized phone-matching rule (last 9 digits, non-digits stripped). The
// chat_messages.contact_phone column is inconsistent — outbound rows historically
// stored the international form ("972…") while inbound rows store the local form
// ("0…") — so an exact `phone_owner = contact_phone` match (the old linking logic)
// missed many. We key off chat_id (always "972…@c.us") and compare the last 9
// digits against both debtor phone fields, the SAME rule the fixed webhook /
// composer linking now uses.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { Client } from 'pg';
import { phoneDigitsKey } from '../src/lib/whatsapp';

const APPLY = process.argv.includes('--apply');

const connectionString = process.env.DIRECT_URL;
if (!connectionString) {
  console.error('Missing DIRECT_URL in .env.local');
  process.exit(1);
}

// Match a debtor by the normalized last-9-digit key against either phone field.
const FIND_DEBTOR = `
  select id from public.debtors
   where right(regexp_replace(coalesce(phone_owner,''),  '[^0-9]', '', 'g'), 9) = $1
      or right(regexp_replace(coalesce(phone_tenant,''), '[^0-9]', '', 'g'), 9) = $1
   order by is_archived asc, created_at asc
   limit 1`;

async function main() {
  const c = new Client({ connectionString });
  await c.connect();

  const before = await c.query<{ link_status: string; total: string; null_debtor: string }>(
    `select link_status, count(*)::text total,
            count(*) filter (where debtor_id is null)::text null_debtor
       from public.chat_messages group by link_status`);
  console.log(`\nMode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log('Before:', before.rows);

  // Every non-group conversation that still has at least one message with no debtor.
  const need = await c.query<{ chat_id: string }>(
    `select distinct chat_id from public.chat_messages
      where debtor_id is null and chat_id is not null and chat_id not ilike '%@g.us%'`);

  let convLinked = 0;
  let msgLinked = 0;
  let noMatch = 0;
  const unmatched: string[] = [];

  for (const { chat_id } of need.rows) {
    const key = phoneDigitsKey(chat_id.split('@')[0]);
    if (!key) { noMatch++; unmatched.push(chat_id); continue; }

    const d = await c.query<{ id: string }>(FIND_DEBTOR, [key]);
    if (!d.rows[0]) { noMatch++; unmatched.push(chat_id); continue; }
    const debtorId = d.rows[0].id;

    if (APPLY) {
      const upd = await c.query(
        `update public.chat_messages
            set debtor_id = $1,
                link_status = case when direction = 'received' then 'linked' else link_status end
          where chat_id = $2 and debtor_id is null`,
        [debtorId, chat_id]);
      msgLinked += upd.rowCount ?? 0;
    } else {
      const cnt = await c.query<{ c: string }>(
        `select count(*)::text c from public.chat_messages where chat_id = $1 and debtor_id is null`,
        [chat_id]);
      msgLinked += Number(cnt.rows[0]?.c ?? 0);
    }
    convLinked++;
  }

  // Verification: prove the normalized rule resolves SOME debtor whose phone key
  // matches the conversation, for every non-group conversation. (We do NOT assert
  // it equals the stored debtor: a single phone is often shared across several
  // debtor rows — same person, multiple apartments — so the rule deterministically
  // picks one, which may differ from whichever apartment a past message was sent
  // from. Resolving any phone-key match is the linking guarantee.)
  const verify = await c.query<{ chat_id: string; matches: string; resolved: string | null }>(
    `with convo as (
       select distinct chat_id,
              case when length(regexp_replace(split_part(chat_id,'@',1),'[^0-9]','','g')) >= 9
                   then right(regexp_replace(split_part(chat_id,'@',1),'[^0-9]','','g'),9) end as k
         from public.chat_messages
        where chat_id is not null and chat_id not ilike '%@g.us%'
     )
     select v.chat_id,
            (select count(*) from public.debtors d
              where right(regexp_replace(coalesce(d.phone_owner,''),'[^0-9]','','g'),9) = v.k
                 or right(regexp_replace(coalesce(d.phone_tenant,''),'[^0-9]','','g'),9) = v.k)::text as matches,
            (select id from public.debtors d
              where right(regexp_replace(coalesce(d.phone_owner,''),'[^0-9]','','g'),9) = v.k
                 or right(regexp_replace(coalesce(d.phone_tenant,''),'[^0-9]','','g'),9) = v.k
              order by d.is_archived asc, d.created_at asc limit 1) as resolved
       from convo v where v.k is not null limit 20`);

  console.log('\n--- Summary ---');
  console.log(`Conversations needing link: ${need.rows.length}`);
  console.log(`Conversations linked:       ${convLinked}`);
  console.log(`Messages linked:            ${msgLinked}`);
  console.log(`Conversations with no debtor match: ${noMatch}`);
  if (unmatched.length) console.log('  unmatched chat_ids:', unmatched.slice(0, 30));

  console.log('\n--- Verification (normalized rule resolves a phone-key match per conversation) ---');
  for (const v of verify.rows) {
    const n = Number(v.matches);
    console.log(`  ${v.chat_id}  →  debtor ${(v.resolved ?? 'NONE').slice(0, 8)}  (${n} debtor row${n === 1 ? '' : 's'} share this number)  ${v.resolved ? '✓' : '✗ NO MATCH'}`);
  }

  if (APPLY) {
    const after = await c.query(
      `select link_status, count(*)::text total,
              count(*) filter (where debtor_id is null)::text null_debtor
         from public.chat_messages group by link_status`);
    console.log('\nAfter:', after.rows);
  } else {
    console.log('\n(DRY-RUN — re-run with --apply to write the links.)');
  }

  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
