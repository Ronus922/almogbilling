#!/usr/bin/env node
// INVARIANT: every API route enforces authorization server-side.
//   Each src/app/api/**/route.ts must gate on one of the auth primitives
//   (require*/getCurrentActor/getSession) OR a machine-job shared secret
//   (cron / Green API webhook). Skipping the gate exposes data/mutations to any
//   anonymous caller — these routes use a direct pg pool (service-role level),
//   so there is NO RLS backstop.
import { run, repoRoot, fail, ok } from './_check-lib.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Any of these tokens in the file body ⇒ the route is gated.
const GUARD = /require(Actor|Admin|SuperAdmin|Permission|AnyPermission|NotificationsAccess|CanManageRole)|getCurrentActor|getSession|CRM_CRON_SECRET|BILLING_CRON_SECRET|GREEN_API_WEBHOOK_SECRET/;

// Routes that are legitimately public (pre-auth flows + health + public media).
// Keep tiny and justified — each is unauthenticated BY DESIGN.
const PUBLIC = new Set([
  'src/app/api/health/route.ts',                    // liveness probe, no data
  'src/app/api/auth/login/route.ts',                // establishes a session
  'src/app/api/auth/logout/route.ts',               // clears a session cookie
  'src/app/api/auth/forgot-password/route.ts',      // token-gated, pre-auth
  'src/app/api/auth/reset-password/route.ts',       // token-gated, pre-auth
  'src/app/api/auth/accept-invite/route.ts',        // token-gated, pre-auth
  'src/app/api/auth/google/start/route.ts',         // OAuth redirect
  'src/app/api/auth/google/callback/route.ts',      // OAuth callback (state-gated)
  'src/app/api/public/wa-media/[...path]/route.ts', // deliberately public media proxy
]);

run('check-api-auth', async () => {
  const root = repoRoot();
  const files = execFileSync('bash', ['-c', "cd '" + root + "' && find src/app/api -name route.ts | sort"], {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);

  if (files.length === 0) return fail('לא נמצאו route handlers — האם הנתיב השתנה?');

  let checked = 0;
  for (const rel of files) {
    if (PUBLIC.has(rel)) { ok(`${rel} — public מותר`); continue; }
    const src = readFileSync(join(root, rel), 'utf8');
    if (GUARD.test(src)) checked++;
    else fail(`${rel} — אין guard (require*/getCurrentActor/getSession/cron/webhook-secret) — route חשוף!`);
  }
  if (checked) ok(`${checked} routes מאובטחים בצד שרת (מתוך ${files.length}, ${PUBLIC.size} ציבוריים מתועדים)`);
});
