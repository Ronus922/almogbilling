#!/usr/bin/env node
// INVARIANT: the WhatsApp durable delivery queue never sends the same message
//   twice. A retry / deploy / parallel worker must not create a second delivery
//   item for the same logical send — enforced by a unique index on
//   wa_campaign_recipients.idempotency_key (migration 059, wa_recipients_idem_uidx).
//   Without it, a re-run would re-queue every recipient and dun each debtor again.
//
//   Proof on a THROWAWAY database (created + dropped here, never real data): the
//   unique index rejects a duplicate idempotency_key and allows a distinct one.
//   (The production table is loosely-coupled by design — no hard FKs — so the
//   minimal shape below is faithful to what the invariant depends on.)
import { run, psql, withTempDb, fail, ok, info } from './_check-lib.mjs';

run('check-wa-idempotency', async () => {
  const proof = withTempDb((url) => {
    const q = (sql) => psql(sql, { url, args: ['-c'] });
    q(`create table wa_campaign_recipients (
         id uuid primary key default gen_random_uuid(),
         campaign_id uuid not null,
         idempotency_key text not null,
         status text not null default 'pending'
       );
       create unique index wa_recipients_idem_uidx on wa_campaign_recipients (idempotency_key);`);
    const c = '11111111-1111-1111-1111-111111111111';
    q(`insert into wa_campaign_recipients (campaign_id, idempotency_key) values ('${c}', 'camp1:apt-101');`);
    let rejected = false;
    try { q(`insert into wa_campaign_recipients (campaign_id, idempotency_key) values ('${c}', 'camp1:apt-101');`); }
    catch { rejected = true; }
    let allowed = true;
    try { q(`insert into wa_campaign_recipients (campaign_id, idempotency_key) values ('${c}', 'camp1:apt-102');`); }
    catch { allowed = false; }
    return { rejected, allowed };
  });
  if (proof.rejected) ok('DB חד"פ: idempotency_key חוזר נדחה — retry/deploy לא ייצר נמען כפול');
  else fail('DB חד"פ: unique index על idempotency_key לא מנע כפילות — סכנת שליחה כפולה!');
  if (proof.allowed) ok('DB חד"פ: idempotency_key שונה (נמען אחר) מותר');
  else fail('DB חד"פ: unique index חוסם נמען לגיטימי שונה');
  info('DB חד"פ נמחק');
});
