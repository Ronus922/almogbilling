// No secret on a command line (26/11/2026). A process's arguments are readable
// by every local account on the server (`ps`, /proc/<pid>/cmdline — /proc is
// mounted without hidepid), and Node quotes them in the message of a failed
// execFileSync. So a secret reaches a child process through its stdin or its
// environment (readable only by the same user and root) — never as an argument.
//
// How this test sees it: every tool the scripts start (git, psql, pg_dump, curl,
// docker, sudo, restic) is replaced on PATH by a recorder that writes down its
// arguments — then, for git, runs the real one. Each script runs with a canary
// secret; the test fails if the canary is in any recorded argument, or in what
// the script printed. Each case also proves the recorder was really called and
// that the secret still arrived where it belongs (stdin / PGPASSWORD) — and a
// negative control proves the recorder catches a secret on a command line.
//
// Hermetic: the scripts run from copies in a temp folder, against fake tools;
// nothing reaches a database, a server, Storage or /etc/billing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const REPO = join(__dirname, '..');
// Letters, digits and dashes only: the same in a URL, percent-encoded or not.
const CANARY = `argvcanary-${randomBytes(12).toString('hex')}`;
const TOOLS = ['git', 'psql', 'pg_dump', 'curl', 'docker', 'sudo', 'restic'];

// One recorder for every tool (a symlink per name): tests/helpers/argv-recorder.sh.
const SHIM = `#!/usr/bin/env bash\n${readFileSync(join(__dirname, 'helpers', 'argv-recorder.sh'), 'utf8')}`;

const made: string[] = [];
let realGit = '';

beforeAll(() => {
  realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  expect(realGit).not.toBe('');
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Copies repo files into the sandbox at the same relative paths. */
  copy(...paths: string[]): void;
  write(path: string, text: string): void;
  /** Every recorded call: [tool, ...args]. */
  calls(): string[][];
  stdinLog(): string;
  envLog(): string;
}

function sandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'argv-secret-'));
  made.push(root);
  const bin = join(root, '.shim-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'shim'), SHIM);
  chmodSync(join(bin, 'shim'), 0o755);
  for (const tool of TOOLS) symlinkSync(join(bin, 'shim'), join(bin, tool));
  const logs = { argv: join(root, '.argv.log'), stdin: join(root, '.stdin.log'), env: join(root, '.env.log') };
  for (const f of Object.values(logs)) writeFileSync(f, '');
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: root,
    LANG: 'C.UTF-8',
    REAL_GIT: realGit,
    SHIM_ARGV_LOG: logs.argv,
    SHIM_STDIN_LOG: logs.stdin,
    SHIM_ENV_LOG: logs.env,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnv,
  };
  return {
    root,
    env,
    copy(...paths) {
      for (const p of paths) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        cpSync(join(REPO, p), join(root, p));
      }
    },
    write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    calls: () => readFileSync(logs.argv, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f')),
    stdinLog: () => readFileSync(logs.stdin, 'utf8'),
    envLog: () => readFileSync(logs.env, 'utf8'),
  };
}

function runIn(sb: Sandbox, cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: sb.root, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The canary is on no recorded command line, and not in what the script printed. */
function expectNoSecretOnArgv(sb: Sandbox, output: string, secret = CANARY) {
  const leaked = sb.calls().filter((c) => c.some((a) => a.includes(secret)));
  expect(leaked.map((c) => c[0]), 'a secret on a command line').toEqual([]);
  expect(output.includes(secret), 'a secret in the output').toBe(false);
}

function gitRepo(sb: Sandbox) {
  const git = (...args: string[]) => spawnSync(realGit, ['-C', sb.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8', env: { ...sb.env, PATH: process.env.PATH } });
  git('init', '-q');
  return git;
}

describe('the recorder itself (negative control)', () => {
  it('catches a secret put on a command line', () => {
    const sb = sandbox();
    sb.write('leak.sh', `psql "postgresql://u:${CANARY}@db.example.test/x" -tAc 'select 1'\ncurl -s -H "Authorization: Bearer ${CANARY}" https://example.test\n`);
    runIn(sb, 'bash', ['leak.sh']);
    const leaked = sb.calls().filter((c) => c.some((a) => a.includes(CANARY))).map((c) => c[0]);
    expect(leaked).toEqual(['psql', 'curl']);
  });
});

describe('scripts/check-no-secrets.mjs — git grep gets every value on stdin', () => {
  function setup() {
    const sb = sandbox();
    sb.copy('scripts/check-no-secrets.mjs', 'scripts/_check-lib.mjs');
    const git = gitRepo(sb);
    // .env.local is untracked — exactly like the real one.
    sb.write('.gitignore', '.env.local\n.shim-bin/\n.*.log\nbilling.env.fake\n');
    sb.write('.env.local', `DATABASE_URL=postgresql://app:${CANARY}-db@db.example.test:5432/x\nSMTP_PASS=${CANARY}-smtp\n`);
    sb.write('billing.env.fake', `BILLING_CRON_SECRET=${CANARY}-cron\nSETTINGS_ENC_KEY="${CANARY}-enc"\n`);
    sb.write('README.md', 'nothing secret here\n');
    git('add', '.gitignore', 'README.md', 'scripts');
    git('commit', '-qm', 'init');
    return { sb, git, env: { SHIM_FAKE_BILLING_ENV: join(sb.root, 'billing.env.fake') } };
  }

  it('compares all four values (billing.env + .env.local) with no value on any command line', () => {
    const { sb, env } = setup();
    const r = runIn(sb, process.execPath, ['scripts/check-no-secrets.mjs'], env);
    expect(r.output).toContain('אף אחד מ-4 ערכי הסוד');
    expect(r.status).toBe(0);
    const greps = sb.calls().filter((c) => c[0] === 'git' && c.includes('grep') && c.includes('-F'));
    expect(greps).toHaveLength(4);
    for (const g of greps) expect(g.slice(-2)).toEqual(['-f', '-']);
    expectNoSecretOnArgv(sb, r.output);
  });

  it('still finds a committed value (the stdin pattern really greps) — and names only its key', () => {
    const { sb, git, env } = setup();
    sb.write('docs/oops.md', `the smtp password is ${CANARY}-smtp\n`);
    git('add', 'docs/oops.md');
    git('commit', '-qm', 'leak');
    const r = runIn(sb, process.execPath, ['scripts/check-no-secrets.mjs'], env);
    expect(r.status).toBe(1);
    expect(r.output).toContain('הערך של SMTP_PASS מופיע בקבצים במעקב: docs/oops.md');
    expectNoSecretOnArgv(sb, r.output);
  });
});

describe('scripts/_check-lib.mjs — psql gets the URL without its password', () => {
  function setup(psqlMode: 'ok' | 'fail') {
    const sb = sandbox({ SHIM_PSQL: psqlMode, SHIM_PSQL_OUT: '0', SHIM_EXPECT_PGPASSWORD: `p@ss-${CANARY}` });
    sb.copy('scripts/_check-lib.mjs', 'scripts/check-session-hash.mjs');
    // Percent-encoded in the URL (as libpq reads it), decoded in PGPASSWORD.
    sb.write('.env.local', `DIRECT_URL=postgresql://postgres.tenant:p%40ss-${CANARY}@db.example.test:5432/proj?sslmode=disable\n`);
    return sb;
  }

  it('a passing check: the password only in PGPASSWORD', () => {
    const sb = setup('ok');
    const r = runIn(sb, process.execPath, ['scripts/check-session-hash.mjs']);
    expect(r.status).toBe(0);
    const psqls = sb.calls().filter((c) => c[0] === 'psql');
    expect(psqls.length).toBeGreaterThan(0);
    expect(psqls[0]![1]).toBe('postgresql://postgres.tenant@db.example.test:5432/proj?sslmode=disable');
    expect(sb.envLog().trim().split('\n')).toEqual(psqls.map(() => 'psql PGPASSWORD=expected'));
    expectNoSecretOnArgv(sb, r.output);
  });

  it('psql FAILS: the printed error (Node quotes the command line) has no password either', () => {
    const sb = setup('fail');
    const r = runIn(sb, process.execPath, ['scripts/check-session-hash.mjs']);
    expect(r.status).toBe(1);
    expect(r.output).toContain('שגיאה בלתי צפויה: Command failed: psql postgresql://postgres.tenant@db.example.test');
    expectNoSecretOnArgv(sb, r.output);
  });

  it('the unique-violation proofs (psql -f - on stdin) too', () => {
    const sb = setup('fail');
    const r = runIn(sb, process.execPath, ['scripts/_check-lib.mjs', '--self-test']);
    expect(sb.calls().filter((c) => c[0] === 'psql' && c.includes('-f'))).toHaveLength(1);
    expect(sb.envLog()).toContain('psql PGPASSWORD=expected');
    expectNoSecretOnArgv(sb, r.output);
  });
});

describe('scripts/lib/pg-url.sh — the shell scripts\' psql / pg_dump', () => {
  const url = `postgresql://app.tenant:p%40ss%2F-${CANARY}@db.example.test:5432/proj_x?sslmode=disable`;
  const decoded = `p@ss/-${CANARY}`;

  it('db:dump (scripts/db/dump-schema.sh)', () => {
    const sb = sandbox({ SHIM_EXPECT_PGPASSWORD: decoded, SHIM_PSQL_OUT: '' });
    sb.copy('scripts/db/dump-schema.sh', 'scripts/lib/pg-url.sh');
    const r = runIn(sb, 'bash', ['scripts/db/dump-schema.sh', 'out.sql'], { DATABASE_URL: url });
    expect(r.status).toBe(0);
    expect(readFileSync(join(sb.root, 'out.sql'), 'utf8')).toContain('-- fake dump');
    const tools = sb.calls().map((c) => c[0]);
    expect(tools).toEqual(['pg_dump', 'psql']);
    for (const c of sb.calls()) expect(c[1]).toBe('postgresql://app.tenant@db.example.test:5432/proj_x?sslmode=disable');
    expect(sb.envLog().trim().split('\n')).toEqual(['pg_dump PGPASSWORD=expected', 'psql PGPASSWORD=expected']);
    expectNoSecretOnArgv(sb, r.output);
  });

  it('the e2e seed (scripts/e2e/seed.sh)', () => {
    const sb = sandbox({ SHIM_EXPECT_PGPASSWORD: decoded });
    sb.copy('scripts/e2e/seed.sh', 'scripts/lib/pg-url.sh');
    sb.write('db/seed/e2e.sql', 'select 1;\n');
    sb.write('scripts/e2e/seed-whatsapp-instance.mjs', 'process.exit(process.env.DATABASE_URL ? 0 : 3);\n');
    const r = runIn(sb, 'bash', ['scripts/e2e/seed.sh'], { DATABASE_URL: url });
    expect(r.status).toBe(0);
    expect(sb.calls().map((c) => c[0])).toEqual(['psql']);
    expect(sb.envLog().trim()).toBe('psql PGPASSWORD=expected');
    expectNoSecretOnArgv(sb, r.output);
  });

  it('a URL without a password, and a conninfo, pass through unchanged', () => {
    const sb = sandbox();
    sb.copy('scripts/lib/pg-url.sh');
    const out = runIn(sb, 'bash', ['-c', `. scripts/lib/pg-url.sh
for u in 'postgresql://u@h:5432/d' 'postgres://u:@h/d' 'host=h user=u dbname=d'; do unset PGPASSWORD; pg_url_split "$u"; printf '%s|%s\\n' "$PG_URL" "\${PGPASSWORD-unset}"; done`]).output;
    expect(out.trim().split('\n')).toEqual(['postgresql://u@h:5432/d|unset', 'postgres://u@h/d|unset', 'host=h user=u dbname=d|unset']);
  });
});

describe('the manual API smoke tests — DB password, session cookie and cron secret off the command line', () => {
  function setup() {
    const sb = sandbox({
      SHIM_EXPECT_PGPASSWORD: `${CANARY}-db`,
      SHIM_PSQL_OUT: '00000000-0000-4000-8000-000000000001',
    });
    sb.write('.env.local', `DIRECT_URL=postgresql://app:${CANARY}-db@db.example.test:5432/x\nPORT=3999\n`);
    sb.write('billing.env.fake', `BILLING_CRON_SECRET=${CANARY}-cron\n`);
    return sb;
  }

  it('scripts/test-tasks-api.sh', () => {
    const sb = setup();
    sb.copy('scripts/test-tasks-api.sh', 'scripts/lib/pg-url.sh');
    const r = runIn(sb, 'bash', ['scripts/test-tasks-api.sh'], { SHIM_FAKE_BILLING_ENV: join(sb.root, 'billing.env.fake') });
    const curls = sb.calls().filter((c) => c[0] === 'curl');
    expect(curls.length).toBeGreaterThanOrEqual(6);
    expect(sb.calls().filter((c) => c[0] === 'psql').length).toBeGreaterThan(3);
    // The cookie came from a header file, the cron secret on stdin.
    expect(curls.filter((c) => c.some((a) => /^@\/.+/.test(a))).length).toBeGreaterThan(0);
    expect(sb.stdinLog()).toContain(`x-cron-secret: ${CANARY}-cron`);
    expect(sb.envLog()).toContain('psql PGPASSWORD=expected');
    expect(sb.envLog()).not.toContain('PGPASSWORD=other');
    expectNoSecretOnArgv(sb, r.output);
    // The session id itself (in the header file) never reached a command line.
    expect(sb.calls().some((c) => c.some((a) => a.includes('almog_sid=')))).toBe(false);
  });

  it('scripts/test-contacts-api.sh', () => {
    const sb = setup();
    sb.copy('scripts/test-contacts-api.sh', 'scripts/lib/pg-url.sh');
    const r = runIn(sb, 'bash', ['scripts/test-contacts-api.sh']);
    expect(sb.calls().filter((c) => c[0] === 'curl').length).toBeGreaterThan(0);
    expect(sb.envLog()).not.toContain('PGPASSWORD=other');
    expectNoSecretOnArgv(sb, r.output);
    expect(sb.calls().some((c) => c.some((a) => a.includes('almog_sid=')))).toBe(false);
  });
});

describe('the production timers — the healthchecks ping URL reaches curl on stdin', () => {
  const pingUrl = `https://hc-ping.example.test/${CANARY}-hc`;

  it('scripts/run-reminders.sh: success pings the URL, the cron secret on stdin', () => {
    const sb = sandbox();
    sb.copy('scripts/run-reminders.sh');
    const r = runIn(sb, 'bash', ['scripts/run-reminders.sh'], { BILLING_CRON_SECRET: `${CANARY}-cron`, HEALTHCHECK_REMINDERS_URL: pingUrl });
    expect(r.status).toBe(0);
    expect(sb.calls().map((c) => c[0])).toEqual(['curl', 'curl']);
    expect(sb.stdinLog()).toContain(`x-cron-secret: ${CANARY}-cron`);
    expect(sb.stdinLog()).toContain(`url = "${pingUrl}"`);
    expectNoSecretOnArgv(sb, r.output);
  });

  it('scripts/run-reminders.sh: a failed run pings …/fail and still exits non-zero', () => {
    const sb = sandbox({ SHIM_CURL_FAIL_ON: 'x-cron-secret' });
    sb.copy('scripts/run-reminders.sh');
    const r = runIn(sb, 'bash', ['scripts/run-reminders.sh'], { BILLING_CRON_SECRET: `${CANARY}-cron`, HEALTHCHECK_REMINDERS_URL: pingUrl });
    expect(r.status).toBe(22);
    expect(sb.stdinLog()).toContain(`url = "${pingUrl}/fail"`);
    expectNoSecretOnArgv(sb, r.output);
  });

  it('scripts/backup/pg-backup.sh: the success ping after both dumps', () => {
    const sb = sandbox();
    sb.copy('scripts/backup/pg-backup.sh');
    const backups = join(sb.root, 'backups');
    const r = runIn(sb, 'bash', ['scripts/backup/pg-backup.sh'], { BACKUP_DIR: backups, MIN_BYTES: '10', HEALTHCHECK_BACKUP_URL: pingUrl });
    expect(r.status).toBe(0);
    expect(r.output).toContain('[pg-backup] done:');
    expect(sb.calls().filter((c) => c[0] === 'curl')).toHaveLength(1);
    expect(sb.stdinLog()).toContain(`url = "${pingUrl}"`);
    expect(sb.stdinLog()).not.toContain('/fail');
    expectNoSecretOnArgv(sb, r.output);
  });

  it('scripts/backup/restic-push.sh: a failed push (not under the retry wrapper) pings …/fail', () => {
    const sb = sandbox();
    sb.copy('scripts/backup/restic-push.sh');
    const backups = join(sb.root, 'backups');
    mkdirSync(backups);
    const r = runIn(sb, 'bash', ['scripts/backup/restic-push.sh'], {
      BACKUP_DIR: backups, STORAGE_DIR: '', RESTIC_REPOSITORY: 'b2:fake-bucket:/x', RESTIC_PASSWORD: 'fake', HEALTHCHECK_BACKUP_URL: pingUrl,
    });
    expect(r.status).toBe(1);
    expect(sb.stdinLog()).toContain(`url = "${pingUrl}/fail"`);
    expectNoSecretOnArgv(sb, r.output);
  });
});

describe('scripts/backup/pg-restore.sh — the throwaway container\'s password', () => {
  it('random, given to docker through its environment, never printed; no port without --keep', () => {
    const sb = sandbox();
    sb.copy('scripts/backup/pg-restore.sh');
    const dump = join(sb.root, 'proj_billing-20260101-000000.sql.gz');
    writeFileSync(dump, gzipSync('select 1;\n'));
    const r = runIn(sb, 'bash', ['scripts/backup/pg-restore.sh', dump]);
    expect(r.output).toContain('RESTORE OK');
    const password = /docker-run POSTGRES_PASSWORD=(.*)/.exec(sb.envLog())?.[1] ?? '';
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    const run = sb.calls().find((c) => c[0] === 'docker' && c[1] === 'run')!;
    expect(run).toContain('POSTGRES_PASSWORD');
    expect(run).not.toContain('-p');
    expectNoSecretOnArgv(sb, r.output, password);
  });

  it('--keep: the port is published, and the line it prints has no password', () => {
    const sb = sandbox();
    sb.copy('scripts/backup/pg-restore.sh');
    const dump = join(sb.root, 'proj_billing-20260101-000000.sql.gz');
    writeFileSync(dump, gzipSync('select 1;\n'));
    const r = runIn(sb, 'bash', ['scripts/backup/pg-restore.sh', '--keep', dump]);
    const password = /docker-run POSTGRES_PASSWORD=(.*)/.exec(sb.envLog())?.[1] ?? '';
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(sb.calls().find((c) => c[0] === 'docker' && c[1] === 'run')).toContain('127.0.0.1:55440:5432');
    expect(r.output).toContain('docker exec -it');
    expectNoSecretOnArgv(sb, r.output, password);
  });
});

describe('scripts/create-super-admin.ts / create-first-user.ts — the password is not an argument', () => {
  const tsx = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  it.skipIf(!existsSync(tsx))('a password on the command line is refused before anything else runs', () => {
    const sb = sandbox();
    for (const [script, args] of [
      ['scripts/create-super-admin.ts', ['a@example.test', 'שם מלא', `${CANARY}-pw`]],
      ['scripts/create-first-user.ts', ['someone', 'a@example.test', `${CANARY}-pw`]],
    ] as const) {
      const r = spawnSync(process.execPath, [tsx, join(REPO, script), ...args], { cwd: sb.root, env: sb.env, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, script).toBe(1);
      expect(`${r.stdout}${r.stderr}`, script).toContain('The password is not taken from the command line');
    }
  });
});
