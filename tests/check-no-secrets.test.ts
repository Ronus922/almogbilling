import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// scripts/check-no-secrets.mjs against throwaway git repos. The script finds the
// repo through its own location (repoRoot() = scripts/..), so each case copies
// it and _check-lib.mjs into a fresh repo and runs the copy there.
//
// The "git fails" cases are the regression this file exists for: grepFixed and
// grepRegex used to `catch { return [] }`, so a git grep that crashed read as
// "no match" and the check passed without scanning anything.

const SCRIPTS = resolve(__dirname, '..', 'scripts');
let sandbox: string;
let noSudoBin: string;   // `sudo` that always fails: keeps /etc/billing/billing.env out of the test
let failingGitBin: string; // `git` that dies on `grep` only — ls-files and log still work

// Built at runtime so this file holds no key-shaped string of its own.
const FAKE_ANTHROPIC_KEY = 'sk-' + 'ant-' + 'x'.repeat(24);
const FAKE_SECRET_VALUE = 'fake-db-password-for-check-no-secrets-test';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'check-no-secrets-'));
  noSudoBin = join(sandbox, 'no-sudo');
  failingGitBin = join(sandbox, 'failing-git');
  mkdirSync(noSudoBin);
  mkdirSync(failingGitBin);
  writeFileSync(join(noSudoBin, 'sudo'), '#!/bin/sh\nexit 1\n');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(failingGitBin, 'git'),
    '#!/bin/sh\n' +
      'for a in "$@"; do [ "$a" = grep ] && { echo "fatal: simulated git grep failure" >&2; exit 128; }; done\n' +
      `exec "${realGit}" "$@"\n`,
  );
  chmodSync(join(noSudoBin, 'sudo'), 0o755);
  chmodSync(join(failingGitBin, 'git'), 0o755);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// Without GIT_* from the parent: under a git hook (pre-push) GIT_DIR and friends
// would point every git call here at the real repository.
function cleanEnv(extraPath: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...extraPath, process.env.PATH ?? ''].join(':') };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

interface Case {
  tracked: Record<string, string>; // committed files
  envLocal?: string;               // untracked .env.local (source of secret values)
  gitFailsOnGrep?: boolean;
}

function runCheck(name: string, c: Case): { status: number | null; output: string } {
  const repo = join(sandbox, name);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(SCRIPTS, 'check-no-secrets.mjs'), join(repo, 'scripts', 'check-no-secrets.mjs'));
  cpSync(join(SCRIPTS, '_check-lib.mjs'), join(repo, 'scripts', '_check-lib.mjs'));

  const env = cleanEnv([noSudoBin]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  git('init', '-q');
  for (const [file, content] of Object.entries(c.tracked)) {
    writeFileSync(join(repo, file), content);
    git('add', file);
  }
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  if (c.envLocal !== undefined) writeFileSync(join(repo, '.env.local'), c.envLocal);

  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'check-no-secrets.mjs')], {
    cwd: repo,
    env: c.gitFailsOnGrep ? cleanEnv([failingGitBin, noSudoBin]) : env,
    encoding: 'utf8',
  });
  return { status: r.status, output: r.stdout + r.stderr };
}

describe('check-no-secrets', () => {
  it('passes on a clean repo (git grep exit 1 = no match)', () => {
    const r = runCheck('clean', {
      tracked: { 'app.ts': 'export const x = 1;\n' },
      envLocal: `DATABASE_URL=${FAKE_SECRET_VALUE}\n`,
    });
    expect(r.output).toContain('✓ check-no-secrets — עבר');
    expect(r.status).toBe(0);
  });

  it('fails when a secret value from .env.local is in a tracked file', () => {
    const r = runCheck('leaked-value', {
      tracked: { 'config.ts': `export const url = '${FAKE_SECRET_VALUE}';\n` },
      envLocal: `DATABASE_URL=${FAKE_SECRET_VALUE}\n`,
    });
    expect(r.output).toContain('הערך של DATABASE_URL מופיע בקבצים במעקב: config.ts');
    expect(r.output).not.toContain(FAKE_SECRET_VALUE); // names the key, never the value
    expect(r.status).toBe(1);
  });

  it('fails when a key-shaped string is in a tracked file', () => {
    const r = runCheck('leaked-shape', {
      tracked: { 'client.ts': `const key = '${FAKE_ANTHROPIC_KEY}';\n` },
    });
    expect(r.output).toContain('מפתח Anthropic');
    expect(r.status).toBe(1);
  });

  it('fails, not passes, when git grep crashes while comparing secret values (grepFixed)', () => {
    const r = runCheck('git-fails-fixed', {
      tracked: { 'app.ts': 'export const x = 1;\n' },
      envLocal: `DATABASE_URL=${FAKE_SECRET_VALUE}\n`,
      gitFailsOnGrep: true,
    });
    expect(r.output).toContain('git grep נכשל');
    expect(r.output).not.toContain(FAKE_SECRET_VALUE);
    expect(r.status).toBe(1);
  });

  it('fails, not passes, when git grep crashes while matching key shapes (grepRegex)', () => {
    const r = runCheck('git-fails-regex', {
      tracked: { 'app.ts': 'export const x = 1;\n' },
      gitFailsOnGrep: true,
    });
    expect(r.output).toContain('git grep נכשל');
    expect(r.status).toBe(1);
  });
});
