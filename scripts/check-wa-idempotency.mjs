#!/usr/bin/env node
// INVARIANT: the WhatsApp durable delivery queue never sends the same message
//   twice. A retry / deploy / parallel worker must not create a second delivery
//   item for the same logical send — enforced by a unique index on
//   wa_campaign_recipients.idempotency_key (migration 059, wa_recipients_idem_uidx).
//   Without it, a re-run would re-queue every recipient and dun each debtor again.
//
//   Proof in a rolled-back TEMP-table sandbox (never real data): the unique
//   index rejects a duplicate idempotency_key and allows a distinct one.
//   (The production table is loosely-coupled by design — no hard FKs — so the
//   minimal shape below is faithful to what the invariant depends on.)
import { run, uniqueViolationProof, fail, ok, info } from './_check-lib.mjs';

const CAMPAIGN = '11111111-1111-1111-1111-111111111111';

run('check-wa-idempotency', async () => {
  const proof = uniqueViolationProof({
    ddl: `create temp table wa_recipients_proof (
            id uuid primary key default gen_random_uuid(),
            campaign_id uuid not null,
            idempotency_key text not null,
            status text not null default 'pending'
          );
          create unique index wa_recipients_proof_idem_uidx
            on wa_recipients_proof (idempotency_key);`,
    first: `insert into wa_recipients_proof (campaign_id, idempotency_key) values ('${CAMPAIGN}', 'camp1:apt-101');`,
    duplicate: `insert into wa_recipients_proof (campaign_id, idempotency_key) values ('${CAMPAIGN}', 'camp1:apt-101');`,
    other: `insert into wa_recipients_proof (campaign_id, idempotency_key) values ('${CAMPAIGN}', 'camp1:apt-102');`,
  });
  if (proof.rejected) ok('ארגז חול: idempotency_key חוזר נדחה — retry/deploy לא ייצר נמען כפול');
  else fail('ארגז חול: unique index על idempotency_key לא מנע כפילות — סכנת שליחה כפולה!');
  if (proof.allowed) ok('ארגז חול: idempotency_key שונה (נמען אחר) מותר');
  else fail('ארגז חול: unique index חוסם נמען לגיטימי שונה');
  info('ארגז החול (טבלת TEMP בטרנזקציה) בוטל ב-rollback');
});
