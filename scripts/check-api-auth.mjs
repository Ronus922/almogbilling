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
//   requireDriveConnector = requireAdmin + finance:edit (src/lib/finance/drive-oauth.ts).
//   requireAssistantAccess = staff-role allowlist + dashboard/contacts view (src/lib/auth/actor.ts).
//   requirePortalSession = the owners portal's OWN session guard (portal_session
//     cookie + "is this phone still an active owner", src/lib/portal/session.ts).
//     A separate auth layer, not a weaker one: it grants nothing outside /portal.
//   requirePortalFinanceAccess = requirePortalSession + "not a blocked phone"
//     (the portal's one identity, 03/10/2026, src/lib/portal/identity.ts) — the
//     guard of the portal's financial endpoints.
//   requireUserDeleteAccess = the USER_DELETE_ROLES allowlist (super admin only)
//     of the permanent user deletion, DELETE /api/users/[id] (06/10/2026).
//   requireVisitor{View,Create,Edit,Manage} = the VISITOR_*_ROLES allowlists of the
//     visitor-scan screen (08/11/2026); requireNonGuardActor / requireGuardActor =
//     "signed in, and not / only the single-screen guard" (src/lib/auth/actor.ts).
const GUARD = /require(Actor|Admin|SuperAdmin|Permission|AnyPermission|NotificationsAccess|AssistantAccess|CanManageRole|DriveConnector|PortalSession|PortalFinanceAccess|UserDeleteAccess|PurchasingAny|PurchasingType|PurchasingSettings|NonGuardActor|GuardActor|VisitorView|VisitorCreate|VisitorEdit|VisitorManage)|getCurrentActor|getSession|CRM_CRON_SECRET|BILLING_CRON_SECRET|GREENAPI_WEBHOOK_TOKEN/;

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
  // Owners portal, pre-auth — the exact counterparts of the three staff entries
  // above: request a WhatsApp code, exchange it for a session, drop a session.
  // They reveal no resident data; every /portal read is behind requirePortalSession.
  'src/app/api/portal/otp/request/route.ts',
  'src/app/api/portal/otp/verify/route.ts',
  'src/app/api/portal/logout/route.ts',
  // A fire-and-forget beacon from step 2, same pre-auth reach as the two
  // above — no phone, no code, just a WebOTP lifecycle label.
  'src/app/api/portal/otp/webotp-diag/route.ts',
  // Purchasing: the personal link of ONE supplier on ONE request (21/10/2026).
  // Token-gated (32 random bytes, scoped to (request, supplier)), rate-limited
  // per IP and per token (src/lib/purchasing/publicGate.ts), no session.
  'src/app/api/public/quote/[token]/route.ts',
  'src/app/api/public/quote/[token]/files/route.ts',
  'src/app/api/public/quote/[token]/logo/route.ts',
  'src/app/api/public/quote/[token]/files/[fileId]/route.ts',
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

  // ── The guard ("שומר", 08/11/2026) holds ONE screen. A handler that only asks
  //    "is anyone signed in?" (getSession / getCurrentActor / requireActor — the
  //    "any authenticated user" reads) would answer it too, so each such handler
  //    must either refuse the guard by name (isGuardRole / requireNonGuardActor),
  //    or check a permission itself (hasPermission). /api/auth/me is the
  //    caller's own identity and is exempt. Found by the API crawl in
  //    e2e/visitors.spec.ts: /api/contacts, /api/contacts/[id], /api/settings/billing.
  const STRONG = /require(Permission|AnyPermission|Admin|SuperAdmin|CanManageRole|UserDeleteAccess|Purchasing\w*|DriveConnector|PortalSession|PortalFinanceAccess|Visitor\w+|GuardActor|NonGuardActor|NotificationsAccess|AssistantAccess)\b|CRON_SECRET|WEBHOOK_TOKEN/;
  const WEAK = /getSession\(|getCurrentActor\(|requireActor\(/;
  const REFUSES_GUARD = /isGuardRole|NonGuardActor|hasPermission\(/;
  const SESSION_ONLY_OK = new Set(['src/app/api/auth/me/route.ts']);
  let handlers = 0;
  for (const rel of files) {
    if (PUBLIC.has(rel) || SESSION_ONLY_OK.has(rel)) continue;
    const src = readFileSync(join(root, rel), 'utf8');
    const parts = src.split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
    for (const body of parts) {
      if (STRONG.test(body) || !WEAK.test(body)) continue;
      handlers++;
      const name = /export async function (\w+)/.exec(body)?.[1] ?? '?';
      if (!REFUSES_GUARD.test(body)) fail(`${rel} ${name} — מאמת רק "מחובר" ולא חוסם שומר (isGuardRole / requireNonGuardActor / hasPermission)`);
    }
  }
  ok(`${handlers} handlers של "כל משתמש מחובר" חוסמים את השומר`);
});
