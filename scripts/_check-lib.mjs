// Shared helpers for scripts/check-*.mjs — no external deps (uses psql + fetch).
// ponytail: one tiny lib instead of repeating env parsing + psql plumbing per file.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Parse KEY=VALUE lines (optional `export`, surrounding quotes stripped) into
// a plain map. Shared by the .env.local loader and the runtime-secrets reader so
// both agree on what a value is.
function parseEnvText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Load a KEY=VALUE env file into process.env WITHOUT overriding already-set vars
// (so CI can inject instead). Returns the map read from the FILE itself — what
// the file says, not what process.env ended up holding. Missing file = {}.
export function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const vars = parseEnvText(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return vars;
}

// Local dev env (contains DATABASE_URL / DIRECT_URL for the checks). Returns the
// .env.local map — {} when the file is absent (CI).
export function loadEnv() {
  return loadEnvFile(join(ROOT, '.env.local'));
}

// The runtime secret file lives outside the repo, root-owned 0600. Read it via
// passwordless sudo if available; returns null when unreadable (check degrades
// to .env.local only and says so). Never printed — only KEY names are ever logged.
export function readRuntimeSecrets(path = '/etc/billing/billing.env') {
  let text;
  try {
    text = execFileSync('sudo', ['-n', 'cat', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // no passwordless sudo / file absent
  }
  return parseEnvText(text);
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

// Run a whole SQL script in ONE psql session. Statement errors are NOT fatal
// here (ON_ERROR_STOP=0) — a deliberately-triggered constraint violation is the
// point of the write proofs below — so the caller reads the outcome from marker
// rows in stdout and from the error text in stderr.
function psqlScript(script, url = dbUrl()) {
  if (!url) throw new Error('no DB url (DIRECT_URL/DATABASE_URL) — is .env.local present?');
  const r = spawnSync('psql', [url, '-tA', '-v', 'ON_ERROR_STOP=0', '-f', '-'], {
    encoding: 'utf8',
    input: script,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Prove that a UNIQUE key rejects a duplicate write while admitting a genuinely
 * different one. Runs on TEMP tables inside a transaction that ALWAYS ends in
 * ROLLBACK: real data is never touched AND no elevated privilege is needed —
 * which is why this replaced the old throwaway-database sandbox (the app's DB
 * role has no CREATEDB, so that sandbox could never run).
 *
 * `ddl` must create TEMP tables only. The duplicate insert aborts the
 * transaction, hence the savepoint around it: its marker row is what tells a
 * rejection apart from an accepted duplicate.
 *
 * Returns { rejected, allowed }.
 */
export function uniqueViolationProof({ ddl, first, duplicate, other }, { control = false } = {}) {
  // Before the first REAL proof of the process, prove the detector still
  // detects (see selfTestUniqueViolationProof).
  if (!control) runSelfTestOnce();
  const { stdout, stderr } = psqlScript(`
begin;
${ddl}
${first}
savepoint before_dup;
${duplicate}
select 'DUP_ACCEPTED';
rollback to savepoint before_dup;
${other}
select 'OTHER_ACCEPTED';
rollback;
`);
  const duplicateAccepted = stdout.includes('DUP_ACCEPTED');
  return {
    rejected: !duplicateAccepted && /duplicate key value violates unique constraint/.test(stderr),
    allowed: stdout.includes('OTHER_ACCEPTED'),
  };
}

/**
 * NEGATIVE CONTROL — the same proof against a table with NO unique key must come
 * back `rejected: false`. A proof that quietly stopped detecting anything (a
 * renamed marker, psql wording that no longer matches, stderr swallowed) would
 * otherwise report a green invariant forever. Runs once per process before the
 * first real proof, so a passing check:dupes / check:wa can never come from a
 * broken detector; `node scripts/_check-lib.mjs --self-test` runs it on demand.
 * Throws when the detector is broken — the caller's run() turns that into a
 * clean failure.
 */
export function selfTestUniqueViolationProof() {
  const control = uniqueViolationProof({
    ddl: `create temp table selftest_no_unique_key (k text not null);`,
    first: `insert into selftest_no_unique_key values ('dup');`,
    duplicate: `insert into selftest_no_unique_key values ('dup');`,
    other: `insert into selftest_no_unique_key values ('other');`,
  }, { control: true });
  if (control.rejected || !control.allowed) {
    throw new Error(
      'בקרת-שלילה נכשלה: טבלה ללא unique key החזירה ' + JSON.stringify(control) +
      ' במקום {"rejected":false,"allowed":true} — הוכחת ה-unique אינה מזהה כלום, וירוק ממנה חסר משמעות',
    );
  }
  return control;
}

let selfTested = false;
function runSelfTestOnce() {
  if (selfTested) return;
  selfTested = true; // set first: the control call must not recurse
  selfTestUniqueViolationProof();
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

// `node scripts/_check-lib.mjs --self-test` — run the negative control alone.
// Entry-point test compares resolved paths (a filename match would silently skip
// the block for any copy of this file, e.g. one under test).
const isEntryPoint =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint && process.argv.includes('--self-test')) {
  loadEnv();
  try {
    const control = selfTestUniqueViolationProof();
    console.log('  ✓ בקרת-שלילה: טבלה ללא unique key → ' + JSON.stringify(control));
    console.log('\n✓ self-test — הוכחת ה-unique מזהה שבירה');
  } catch (err) {
    console.error('  ✗ ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
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
