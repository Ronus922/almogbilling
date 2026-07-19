#!/usr/bin/env node
// INVARIANT: public.sessions.id is always a SHA-256 hash (64 lowercase hex),
//   never a raw session token. The raw id lives ONLY in the almog_sid cookie;
//   the DB stores hashToken(raw) (migration 057, src/lib/auth/session.ts). A row
//   that is NOT 64-hex means a raw, replayable token was written — a DB
//   read/backup/replica leak would then hand out live sessions.
// Read-only against the real DB.
import { run, scalar, fail, ok, info } from './_check-lib.mjs';

run('check-session-hash', async () => {
  const bad = scalar(`select count(*) from public.sessions where id !~ '^[0-9a-f]{64}$'`);
  if (bad === '0') {
    const n = scalar(`select count(*) from public.sessions`);
    ok(`כל ${n} ה-sessions מאוחסנים כ-SHA-256 hex (אין טוקן גולמי)`);
  } else {
    fail(`${bad} sessions עם id שאינו SHA-256 hex — טוקן גולמי ניתן-לשחזור ב-DB!`);
    info('צפוי: כל id בן 64 תווי hex. תקן: מחק את השורות הפגומות (התנתקות כפויה).');
  }
});
