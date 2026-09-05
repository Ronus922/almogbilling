#!/usr/bin/env node
// INVARIANT: no secret is committed to git.
//   (1) No .env file other than *.example is tracked.
//   (2) No actual secret VALUE (from /etc/billing/billing.env AND .env.local)
//       appears in any tracked file — catches a real leak regardless of shape.
//       Only those two FILES are sources; process.env is deliberately not one:
//       CI injects a throwaway DATABASE_URL that is written verbatim in ci.yml,
//       and any exported shell variable would likewise read as a false leak.
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

// Same, for an extended-regex pattern (POSIX ERE, as git grep -E takes it).
function grepRegex(root, pattern) {
  try {
    return execFileSync('git', ['-C', root, 'grep', '-l', '-E', '-e', pattern], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return []; // exit 1 = no match
  }
}

run('check-no-secrets', async () => {
  const root = repoRoot();
  const local = loadEnv();              // .env.local → {} when absent (CI)
  const runtime = readRuntimeSecrets(); // billing.env → null when unreadable

  // (1) tracked env files
  const envFiles = tracked(root).filter((f) => /(^|\/)\.env/.test(f) && !f.endsWith('.example'));
  if (envFiles.length === 0) ok('אין קבצי .env במעקב git (מלבד *.example)');
  else fail('קבצי env במעקב git: ' + envFiles.join(', '));

  // (2) literal secret values leaked into tracked files — every distinct value
  // the two files hold for a key (they differ, e.g. prod vs local DATABASE_URL).
  let leaked = 0;
  let compared = 0;
  for (const key of SENSITIVE_KEYS) {
    const values = new Set([runtime?.[key], local[key]].filter((v) => v && v.length >= 12));
    for (const val of values) {
      compared++;
      const hits = grepFixed(root, val).filter((f) => !f.endsWith('.example'));
      if (hits.length) { fail(`הערך של ${key} מופיע בקבצים במעקב: ${hits.join(', ')}`); leaked++; break; }
    }
  }
  if (leaked === 0) {
    if (compared === 0) {
      info('אין ערכי סוד להשוואה (אין .env.local ו-billing.env לא נקרא) — נבדקו רק תבניות');
    } else {
      ok(`אף אחד מ-${compared} ערכי הסוד (billing.env + .env.local) לא מופיע בקבצים במעקב`);
    }
    if (!runtime) info('להרצה מלאה כולל /etc/billing/billing.env דרוש sudo -n cat על הקובץ');
  }

  // (3) generic key SHAPES — deliberately matched as a whole key, not as a bare
  // prefix: the docs (TESTING.md) and this script name the prefixes, and a
  // prefix-only match turns every mention of them into a false failure.
  const patterns = [
    ['"role"[[:space:]]*:[[:space:]]*"service_role"', 'JWT service_role'],
    ['sk-ant-[A-Za-z0-9_-]{20,}', 'מפתח Anthropic'],
    ['-----BEGIN [A-Z ]*PRIVATE KEY-----', 'מפתח פרטי'],
  ];
  let patternHit = 0;
  for (const [pattern, label] of patterns) {
    const hits = grepRegex(root, pattern).filter((f) => !f.endsWith('.example') && !f.startsWith('scripts/check-'));
    if (hits.length) { fail(`${label} (${pattern}) בקבצים: ${hits.join(', ')}`); patternHit++; }
  }
  if (patternHit === 0) ok('אין תבניות מפתח חשודות בקוד המנוהל');
});
