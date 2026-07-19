// Shared helpers for scripts/check-*.mjs — no external deps (uses psql + fetch).
// ponytail: one tiny lib instead of repeating env parsing + psql plumbing per file.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load a KEY=VALUE env file into process.env WITHOUT overriding already-set vars
// (so CI can inject instead). Quotes stripped. Missing file = no-op.
export function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

// Local dev env (contains DATABASE_URL / DIRECT_URL for the checks).
export function loadEnv() {
  loadEnvFile(join(ROOT, '.env.local'));
}

// The runtime secret file lives outside the repo, root-owned 0600. Read it via
// passwordless sudo if available; returns {} when unreadable (check degrades to
// .env.local only and says so). Never printed — only KEY names are ever logged.
export function readRuntimeSecrets(path = '/etc/billing/billing.env') {
  let text;
  try {
    text = execFileSync('sudo', ['-n', 'cat', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // no passwordless sudo / file absent
  }
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function repoRoot() {
  return ROOT;
}

// DB url for the checks: session pooler (DIRECT_URL) preferred, else DATABASE_URL.
export function dbUrl() {
  return process.env.DIRECT_URL || process.env.DATABASE_URL || null;
}

// Run one SQL statement, return trimmed stdout. Throws on psql error. stderr is
// piped (not inherited) so a deliberately-triggered error (e.g. a unique
// violation we're testing) doesn't leak ERROR text to the console.
export function psql(sql, { url = dbUrl(), args = ['-tAc'] } = {}) {
  if (!url) throw new Error('no DB url (DIRECT_URL/DATABASE_URL) — is .env.local present?');
  return execFileSync('psql', [url, ...args, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// First scalar (first column of first row) as a string.
export function scalar(sql, opts) {
  return psql(sql, opts).split('\n')[0].trim();
}

// Create a THROWAWAY database on the same cluster, run fn(tmpUrl) against it,
// and drop it in finally — so a write test never touches real data. fn is sync
// (psql is sync). The db-name swap mirrors the connection string's path.
export function withTempDb(fn) {
  const admin = dbUrl();
  if (!admin) throw new Error('no DB url — cannot run isolated write test');
  const name = `billing_check_${process.pid}_${Date.now()}`;
  const tmpUrl = admin.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  psql(`create database "${name}"`, { args: ['-c'] });
  try {
    return fn(tmpUrl);
  } finally {
    // WITH (FORCE) drops even if a session is still closing (PG 13+).
    psql(`drop database if exists "${name}" with (force)`, { args: ['-c'] });
  }
}

let failed = false;
const problems = [];

export function fail(msg) { failed = true; problems.push(msg); console.error('  ✗ ' + msg); }
export function ok(msg) { console.log('  ✓ ' + msg); }
export function info(msg) { console.log('  · ' + msg); }

// Call at the end of every check. Exit 0 only if nothing failed.
export function done(name) {
  if (failed) {
    console.error(`\n✗ ${name} — נכשל (${problems.length} בעיות)`);
    process.exit(1);
  }
  console.log(`\n✓ ${name} — עבר`);
  process.exit(0);
}

// Wrap a check body so a thrown error is a clean failure, not a stack dump.
export async function run(name, body) {
  console.log(`\n▶ ${name}`);
  loadEnv();
  try {
    await body();
  } catch (err) {
    fail('שגיאה בלתי צפויה: ' + (err instanceof Error ? err.message : String(err)));
  }
  done(name);
}
