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
//   requireChipPickup = the CHIP_PICKUP_ROLES allowlist of the guard's pickup
//     screen (25/11/2026): the two routes under /api/chip-pickup and no other.
const GUARD = /require(Actor|Admin|SuperAdmin|Permission|AnyPermission|NotificationsAccess|AssistantAccess|CanManageRole|DriveConnector|PortalSession|PortalFinanceAccess|UserDeleteAccess|PurchasingAny|PurchasingType|PurchasingSettings|NonGuardActor|GuardActor|VisitorView|VisitorCreate|VisitorEdit|VisitorManage|ChipPickup)|getCurrentActor|getSession|CRM_CRON_SECRET|BILLING_CRON_SECRET|GREENAPI_WEBHOOK_TOKEN/;

// Routes that are legitimately public (pre-auth flows + health + public media).
// Keep tiny and justified — each is unauthenticated BY DESIGN.
const PUBLIC = new Set([
  'src/app/api/health/route.ts',                    // liveness probe, no data
  'src/app/api/auth/login/route.ts',                // establishes a session
  'src/app/api/auth/logout/route.ts',               // clears a session cookie
  // Clears a session cookie that names NO live session (21/11/2026) and ends on
  // /login; a live session is sent home untouched (a GET must never sign out).
  // It returns nothing but a redirect — the guard question does not arise.
  'src/app/api/auth/session-reset/route.ts',
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
  // Chip orders (/chip-order, 12/11/2026) — a resident with no account orders
  // chips. OTP request / verify = the portal's own OTP (purpose 'chip_order'),
  // rate-limited per IP and per phone; the submit needs the sealed
  // "phone verified" cookie, and creates an UNPAID order only. The two Grow
  // callbacks carry our HMAC of the order id, and payment is confirmed only
  // through Grow's API. None of them returns resident data.
  'src/app/api/public/chip-order/otp/request/route.ts',
  'src/app/api/public/chip-order/otp/verify/route.ts',
  'src/app/api/public/chip-order/route.ts',
  'src/app/api/public/chip-order/grow/notify/route.ts',
  'src/app/api/public/chip-order/grow/invoice/route.ts',
  // Test mode (13/11/2026): "סיים הזמנת בדיקה" — 403 without the CURRENT
  // test-link token (hashed in app_settings, constant-time compare); it can
  // only mark a TEST order (is_test) paid, never a real one.
  'src/app/api/public/chip-order/test-finish/route.ts',
  // "דלג על אימות (מצב בדיקה)" (13/11/2026) — 403 without the CURRENT
  // test-link token, also when the page is open to the public. It only seals
  // the typed phone into a skip cookie that the submit honours together with
  // the same token, for a TEST order stored phone_verified = false.
  'src/app/api/public/chip-order/otp/skip/route.ts',
  // Card payment through PayPlus hosted fields (25/11/2026). No session, by
  // design: the order page has no login. `session` and `status` need the
  // current test-link token while PayPlus runs in sandbox, name the order by
  // its tracking token, are rate limited, and never read an amount from the
  // browser. `callback` is called by PayPlus and is refused (401) unless the
  // request is validated the way PayPlus documents it: user-agent "PayPlus"
  // and a `hash` header = HMAC-SHA256 of the body under our secret key.
  'src/app/api/public/chip-order/payplus/session/route.ts',
  'src/app/api/public/chip-order/payplus/status/route.ts',
  'src/app/api/public/chip-order/payplus/callback/route.ts',
  // One static font file (OFL) for the processor's card-field frames: they are
  // another origin, and a font crosses origins only with a CORS header. Reads
  // no input, returns no data.
  'src/app/api/public/chip-order/card-font/route.ts',
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
  const STRONG = /require(Permission|AnyPermission|Admin|SuperAdmin|CanManageRole|UserDeleteAccess|Purchasing\w*|DriveConnector|PortalSession|PortalFinanceAccess|Visitor\w+|GuardActor|NonGuardActor|NotificationsAccess|AssistantAccess|ChipPickup)\b|CRON_SECRET|WEBHOOK_TOKEN/;
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

  // ── The visitor-scan screen (09/11/2026) is guard / admin / super admin ONLY.
  //    A bare requireActor() / getSession() in one of its handlers would answer
  //    EVERY signed-in role (manager, viewer, cleaner, maintenance), so each
  //    handler under /api/visitors must call a requireVisitor* guard — the role
  //    allowlists — and the visitor-ids file bucket must keep its own. Three
  //    holes the security review of 09/11/2026 pointed at are closed here:
  //      · every export form counts (`export async function`, `export function`,
  //        `export const GET = …`), and a visitors route with NO recognisable
  //        handler fails instead of being skipped;
  //      · comments are stripped first, so a commented-out requireVisitorView(
  //        proves nothing;
  //      · the rule is not tied to the folder: ANY route that touches the scans
  //        table or their photos (imports visitorScans / visitorIdStorage /
  //        lib/visitors) must carry the guard too.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const HANDLER_SPLIT = /(?=export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*[=:])/;
  const HANDLER_HEAD = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*[=:]/;
  const VISITOR_GUARD = /requireVisitor(View|Create|Edit|Manage)\(/;
  // `visitors/downloadName` is a pure string function (no DB, no Storage, no session): the shared files
  // route imports it to name a download, and that route is guarded per bucket (checked just below).
  const TOUCHES_VISITORS = /@\/lib\/(db\/visitorScans|storage\/visitorIdStorage|visitors\/(?!downloadName['"]))/;
  let visitorHandlers = 0;
  for (const rel of files) {
    const src = stripComments(readFileSync(join(root, rel), 'utf8'));
    const inFolder = rel.startsWith('src/app/api/visitors/');
    if (!inFolder && !TOUCHES_VISITORS.test(src)) continue;
    const parts = src.split(HANDLER_SPLIT).filter((p) => HANDLER_HEAD.test(p.slice(0, 120)));
    if (parts.length === 0) { fail(`${rel} — נתיב של סריקת כניסה בלי handler שהבדיקה מזהה (export function / export const GET = …)`); continue; }
    for (const body of parts) {
      visitorHandlers++;
      const name = /(GET|POST|PUT|PATCH|DELETE)/.exec(body.slice(0, 120))?.[1] ?? '?';
      if (!VISITOR_GUARD.test(body) || WEAK.test(body)) fail(`${rel} ${name} — חייב requireVisitor* (guard/admin/super admin בלבד) ולא אימות "מחובר" גורף`);
    }
  }
  if (visitorHandlers === 0) fail('לא נמצאו handlers של סריקת כניסה — האם הנתיב השתנה?');
  const filesRoute = stripComments(readFileSync(join(root, 'src/app/api/files/[bucket]/[...path]/route.ts'), 'utf8'));
  if (!/'visitor-ids':\s*\(\)\s*=>\s*requireVisitorView\(\)/.test(filesRoute)) fail("src/app/api/files — הבאקט visitor-ids חייב להישען על requireVisitorView()");
  ok(`${visitorHandlers} handlers של סריקת כניסה נשענים על requireVisitor*; הקבצים של visitor-ids על requireVisitorView`);

  // ── The guard's pickup screen ("מסירת צ׳יפים", 25/11/2026) gives the guard a
  //    way INTO the chips module, so it is fenced from both sides:
  //      · every handler under /api/chip-pickup calls requireChipPickup() — the
  //        role allowlist — and never a bare "anyone signed in" check;
  //      · those routes read an order ONLY through the narrow module
  //        (lib/db/chipPickup) and write through the one hand-over function:
  //        none of the wide chip modules — which carry prices, payment details,
  //        emails, addresses, leases and notes — may be imported there, so a
  //        later edit cannot widen what the guard is sent;
  //      · requireChipPickup() appears in NO other route: the allowlist that
  //        admits the guard must not become the gate of anything else;
  //      · every other chip route keeps a guard the guard cannot pass — a
  //        module permission, the admin roles, or the cron secret.
  const PICKUP_DIR = 'src/app/api/chip-pickup/';
  // The call itself, awaited: `requireChipPickup()` without `await` returns a
  // promise nobody reads, and guards nothing.
  const PICKUP_GUARD = /\bawait\s+requireChipPickup\(\)/;
  // What a pickup route may import — an ALLOW list of modules and of the names
  // taken from each (null = any name). Anything else is refused, so no module
  // reaches the guard's routes without a change to this list.
  const PICKUP_IMPORTS = new Map([
    ['next/server', null],
    ['@/lib/auth/actor', ['requireChipPickup', 'Actor']],
    ['@/lib/auth/apiGuard', ['authErrorResponse']],
    ['@/lib/auth/rateLimit', ['checkRateLimit']],
    ['@/lib/http/body', ['parseJsonBody']],
    ['@/lib/validation/requests', ['chipPickupHandoverBodySchema']],
    ['@/lib/db/chipPickup', ['listReadyPickupOrders']],
    ['@/lib/db/chipOrders', ['markChipOrderCollected']],
    ['@/lib/chipOrders/routeErrors', ['badOrderId', 'chipOrderErrorResponse']],
  ]);
  const IMPORT_FROM = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
  const IMPORT_BARE = /import\s+['"]([^'"]+)['"]/g;
  // Ways a handler could exist without the split below seeing it, or a module
  // could be loaded without an import statement.
  const HIDDEN_HANDLER = /export\s*\{|export\s*\*|export\s+default\b/;
  const DYNAMIC_LOAD = /\bimport\s*\(|\brequire\s*\(/;
  const CHIP_ROUTE = /^src\/app\/api\/(chips\/|chip-orders\/|contacts\/\[id\]\/chips\/|settings\/chip-orders\/|cron\/chip-orders-purge\/)/;
  // …and not by folder alone: ANY route that loads a chip module is a chip route.
  // The card-payment modules count too (25/11/2026): a route that loads the
  // PayPlus client or the card DB layer is a chip route like any other.
  const TOUCHES_CHIPS = /from\s+['"]@\/lib\/(db\/(chips|chipOrders|chipOrderWindow|chipReception|chipPickup|chipLeaseUploads|chipOrderCard)|chipOrders\/(cleanup|testMode|server|cardPayment)|payplus\/client|storage\/chipOrderLeaseStorage)['"]/;
  const CHIP_STRONG = /\bawait\s+require(Permission|AnyPermission|Admin)\(|CRON_SECRET/;
  /** The body of a function declared in `src` — from its name to the brace
   *  that closes it (null when it is not found). */
  const functionBody = (src, fn) => {
    const at = src.search(new RegExp(`function\\s+${fn}\\s*\\(`));
    if (at < 0) return null;
    let i = src.indexOf('(', at);
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    const open = src.indexOf('{', i);
    if (open < 0) return null;
    for (let depth = 0, j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
    }
    return null;
  };
  let pickupHandlers = 0;
  let chipHandlers = 0;
  for (const rel of files) {
    const src = stripComments(readFileSync(join(root, rel), 'utf8'));
    const parts = src.split(HANDLER_SPLIT).filter((p) => HANDLER_HEAD.test(p.slice(0, 120)));
    if (rel.startsWith(PICKUP_DIR)) {
      if (HIDDEN_HANDLER.test(src)) fail(`${rel} — נתיב של מסירת צ׳יפים מייצא handler בצורה שהבדיקה לא קוראת (export { … } / export * / export default)`);
      if (DYNAMIC_LOAD.test(src)) fail(`${rel} — נתיב של מסירת צ׳יפים טוען מודול בלי import רגיל (import() / require())`);
      if (parts.length === 0) { fail(`${rel} — נתיב של מסירת צ׳יפים בלי handler שהבדיקה מזהה`); continue; }
      for (const body of parts) {
        pickupHandlers++;
        const name = /(GET|POST|PUT|PATCH|DELETE)/.exec(body.slice(0, 120))?.[1] ?? '?';
        if (!PICKUP_GUARD.test(body) || WEAK.test(body)) fail(`${rel} ${name} — חייב await requireChipPickup() (שומר/אדמין/סופר אדמין) ולא אימות "מחובר" גורף`);
      }
      for (const m of src.matchAll(IMPORT_BARE)) fail(`${rel} — import בלי שמות (${m[1]}) אסור בנתיב של מסירת צ׳יפים`);
      for (const m of src.matchAll(IMPORT_FROM)) {
        const [, clause, mod] = m;
        if (!PICKUP_IMPORTS.has(mod)) { fail(`${rel} — הייבוא מ-${mod} אינו ברשימה המותרת לנתיבי מסירת צ׳יפים (מסך המסירה קורא הזמנה רק דרך lib/db/chipPickup)`); continue; }
        const allowed = PICKUP_IMPORTS.get(mod);
        if (allowed === null) continue;
        const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
        if (!braces) { fail(`${rel} — מ-${mod} מייבאים בשמות בלבד ({ … }), לא default ולא * as`); continue; }
        const names = braces[1].split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean);
        for (const n of names) {
          if (/\sas\s/.test(n)) fail(`${rel} — ייבוא בשם אחר (${n}) אסור בנתיב של מסירת צ׳יפים`);
          else if (!allowed.includes(n)) fail(`${rel} — מ-${mod} מותר לייבא רק ${allowed.join(', ')} (נמצא: ${n})`);
        }
      }
      continue;
    }
    // The name itself — however it is imported, renamed or called.
    if (/\brequireChipPickup\b/.test(src)) fail(`${rel} — requireChipPickup שמור לנתיבי /api/chip-pickup בלבד`);
    if (PUBLIC.has(rel)) continue; // the public order page: no session at all, by design
    if (CHIP_ROUTE.test(rel) || TOUCHES_CHIPS.test(src)) {
      if (HIDDEN_HANDLER.test(src)) fail(`${rel} — נתיב צ׳יפים מייצא handler בצורה שהבדיקה לא קוראת (export { … } / export * / export default)`);
      if (parts.length === 0) { fail(`${rel} — נתיב צ׳יפים בלי handler שהבדיקה מזהה`); continue; }
      // A handler may reach its guard through a helper of the same file (the
      // test-mode route's `guard(action)`): a function declared before the
      // handlers whose OWN body holds the strong guard.
      const preamble = src.split(HANDLER_SPLIT)[0] ?? '';
      const helpers = [...preamble.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)]
        .map((m) => m[1])
        .filter((fn) => CHIP_STRONG.test(functionBody(preamble, fn) ?? ''));
      if (WEAK.test(src)) fail(`${rel} — נתיב צ׳יפים עם אימות "מחובר" גורף (getSession / getCurrentActor / requireActor)`);
      for (const body of parts) {
        chipHandlers++;
        const name = /(GET|POST|PUT|PATCH|DELETE)/.exec(body.slice(0, 120))?.[1] ?? '?';
        const guarded = CHIP_STRONG.test(body) || helpers.some((fn) => new RegExp(`\\bawait\\s+${fn}\\(`).test(body));
        if (!guarded) fail(`${rel} ${name} — נתיב צ׳יפים חייב הרשאת מודול / תפקיד אדמין / סוד cron (השומר לא עובר אף אחד מהם)`);
      }
    }
  }
  // The name outside the routes too: a page, a server action or a library
  // function must not take the guard's allowlist for its own gate.
  const elsewhere = execFileSync('bash', ['-c', "cd '" + root + "' && /usr/bin/grep -rlw requireChipPickup src --include=*.ts --include=*.tsx || true"], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((f) => !f.startsWith(PICKUP_DIR) && f !== 'src/lib/auth/actor.ts')
    // A mention in a comment is not a use.
    .filter((f) => /\brequireChipPickup\b/.test(stripComments(readFileSync(join(root, f), 'utf8'))));
  for (const f of elsewhere) fail(`${f} — requireChipPickup שמור לנתיבי /api/chip-pickup בלבד`);
  // The three public card-payment routes (PayPlus, 25/11/2026) have no
  // session by design, so each one's own gate is pinned here — it must be
  // CALLED (awaited where it is async), not merely imported:
  //   session, status — the current test-link token AND the card-step
  //                     configuration (sandbox = test orders only);
  //   callback        — PayPlus's signature check, and nothing applied before it.
  const CARD_DIR = 'src/app/api/public/chip-order/payplus/';
  const cardRoute = (name) => {
    const rel = `${CARD_DIR}${name}/route.ts`;
    let src = '';
    try { src = stripComments(readFileSync(join(root, rel), 'utf8')); } catch { fail(`${rel} — הנתיב חסר`); }
    return { rel, src };
  };
  for (const name of ['session', 'status']) {
    const { rel, src } = cardRoute(name);
    if (!/\bawait\s+isTestRequest\(req\)/.test(src)) fail(`${rel} — חייב לבדוק את טוקן הבדיקה (await isTestRequest(req))`);
    if (!/\bcardStepConfig\(\)/.test(src)) fail(`${rel} — חייב לעבור דרך cardStepConfig() (sandbox = הזמנות בדיקה בלבד)`);
    if (/\bpayplusConfig\(/.test(src)) fail(`${rel} — אסור לקרוא ל-payplusConfig() ישירות (עוקף את cardStepConfig)`);
    if (/\b(amount|total|price|sum)\b[^\n]*\bbody\.data\b|\bbody\.data\.(amount|total|price|sum)\b/.test(src)) fail(`${rel} — סכום לא נקרא מהבקשה`);
  }
  {
    // The font route answers one static file: it reads nothing of the request
    // and imports nothing of the application.
    const rel = 'src/app/api/public/chip-order/card-font/route.ts';
    let src = '';
    try { src = stripComments(readFileSync(join(root, rel), 'utf8')); } catch { fail(`${rel} — הנתיב חסר`); }
    if (/from\s+'@\//.test(src)) fail(`${rel} — קובץ פונט סטטי: אסור לייבא מודולים של האפליקציה`);
    if (/\bGET\s*\(\s*\w/.test(src) || /\b(POST|PUT|PATCH|DELETE)\b/.test(src)) fail(`${rel} — GET בלבד, בלי קריאת הבקשה`);
  }
  {
    const { rel, src } = cardRoute('callback');
    const verify = src.search(/\bverifyPayPlusCallback\(/);
    const apply = src.search(/\bapplyPayPlusTransaction\(/);
    if (verify < 0) fail(`${rel} — חייב לאמת את החתימה של PayPlus (verifyPayPlusCallback)`);
    if (apply >= 0 && (verify < 0 || apply < verify)) fail(`${rel} — applyPayPlusTransaction לפני אימות החתימה`);
    if (!/if\s*\(\s*!checked\.ok\s*\)/.test(src)) fail(`${rel} — חייב לדחות בקשה שהחתימה שלה לא אומתה (if (!checked.ok))`);
  }
  // Only those three routes may mark an order paid by card, and the browser
  // side never loads the PayPlus client (its keys are server-only).
  const cardUsers = execFileSync('bash', ['-c', "cd '" + root + "' && /usr/bin/grep -rlE \"recordCardPayment|applyPayPlusTransaction|lookupCardPayment\" src --include=*.ts --include=*.tsx || true"], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((f) => !f.startsWith(CARD_DIR) && f !== 'src/lib/db/chipOrderCard.ts' && f !== 'src/lib/chipOrders/cardPayment.ts')
    // A mention in a comment is not a use.
    .filter((f) => /\b(recordCardPayment|applyPayPlusTransaction|lookupCardPayment)\b/.test(stripComments(readFileSync(join(root, f), 'utf8'))));
  for (const f of cardUsers) fail(`${f} — סימון הזמנה כ„שולם בכרטיס” שמור לשלושת נתיבי ${CARD_DIR}`);
  const clientLoaders = execFileSync('bash', ['-c', "cd '" + root + "' && /usr/bin/grep -rlE \"from ['\\\"]@/lib/payplus/client['\\\"]\" src --include=*.ts --include=*.tsx || true"], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((f) => /^['"]use client['"]/m.test(readFileSync(join(root, f), 'utf8')));
  for (const f of clientLoaders) fail(`${f} — רכיב דפדפן טוען את לקוח PayPlus (המפתחות בצד השרת בלבד)`);

  // The lease files of the orders (a renter's contract) keep their own guard —
  // a module permission the guard does not hold.
  if (!/'chip-order-leases':\s*\(\)\s*=>\s*requirePermission\('chips_orders_manage',\s*'view'\)/.test(filesRoute)) {
    fail("src/app/api/files — הבאקט chip-order-leases חייב להישען על requirePermission('chips_orders_manage', 'view')");
  }
  if (pickupHandlers === 0) fail('לא נמצאו handlers של מסירת צ׳יפים — האם הנתיב השתנה?');
  if (chipHandlers === 0) fail('לא נמצאו handlers של מודול הצ׳יפים — האם הנתיב השתנה?');
  ok(`${pickupHandlers} handlers של מסירת צ׳יפים נשענים על requireChipPickup וקוראים רק דרך המודול הצר; ${chipHandlers} handlers אחרים של צ׳יפים סגורים לשומר`);
});
