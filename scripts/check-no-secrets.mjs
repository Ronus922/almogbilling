#!/usr/bin/env node
// INVARIANT: no secret is committed to git.
//   (1) No .env file other than *.example is tracked.
//   (2) No actual secret VALUE (from /etc/billing/billing.env AND .env.local)
//       appears in any tracked file — catches a real leak regardless of shape.
//   (3) No obvious key patterns (service_role JWT, sk-ant-…, private key) in
//       tracked code.
// Never prints a secret value — only the offending KEY name + file.
import { run, repoRoot, loadEnv, readRuntimeSecrets, fail, ok, info } from './_check-lib.mjs';
import { execFileSync } from 'node:child_process';

// Keys whose VALUES must never appear in the repo.
const SENSITIVE_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'DIRECT_URL', 'SMTP_PASS',
  'SETTINGS_ENC_KEY', 'GREEN_API_WEBHOOK_SECRET', 'CRM_CRON_SECRET',
  'BILLING_CRON_SECRET', 'CRM_DEBTORS_REST_KEY', 'GOOGLE_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
];

function tracked(root) {
  return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

// git grep for a fixed string; returns matching files (empty on no match).
function grepFixed(root, needle) {
  try {
    return execFileSync('git', ['-C', root, 'grep', '-l', '-F', '-e', needle], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return []; // exit 1 = no match
  }
}

run('check-no-secrets', async () => {
  const root = repoRoot();
  loadEnv();
  const runtime = readRuntimeSecrets(); // {} of KEY→value, or null if unreadable

  // (1) tracked env files
  const envFiles = tracked(root).filter((f) => /(^|\/)\.env/.test(f) && !f.endsWith('.example'));
  if (envFiles.length === 0) ok('אין קבצי .env במעקב git (מלבד *.example)');
  else fail('קבצי env במעקב git: ' + envFiles.join(', '));

  // (2) literal secret values leaked into tracked files
  let leaked = 0;
  for (const key of SENSITIVE_KEYS) {
    const val = (runtime && runtime[key]) || process.env[key];
    if (!val || val.length < 12) continue;
    const hits = grepFixed(root, val).filter((f) => !f.endsWith('.example'));
    if (hits.length) { fail(`הערך של ${key} מופיע בקבצים במעקב: ${hits.join(', ')}`); leaked++; }
  }
  if (leaked === 0) {
    ok(runtime
      ? 'אף ערך סוד (billing.env + .env.local) לא מופיע בקבצים במעקב'
      : 'אף ערך סוד מ-.env.local לא מופיע בקבצים במעקב (billing.env לא נקרא — אין sudo)');
    if (!runtime) info('להרצה מלאה כולל /etc/billing/billing.env דרוש sudo -n cat על הקובץ');
  }

  // (3) generic key shapes
  const patterns = [
    ['"role":"service_role"', 'JWT service_role'],
    ['sk-ant-', 'מפתח Anthropic'],
    ['-----BEGIN', 'מפתח פרטי'],
  ];
  let patternHit = 0;
  for (const [needle, label] of patterns) {
    const hits = grepFixed(root, needle).filter((f) => !f.endsWith('.example') && !f.startsWith('scripts/check-'));
    if (hits.length) { fail(`${label} (${needle}) בקבצים: ${hits.join(', ')}`); patternHit++; }
  }
  if (patternHit === 0) ok('אין תבניות מפתח חשודות בקוד המנוהל');
});
