#!/usr/bin/env node
// INVARIANT: a build made WITHOUT a DSN still carries the server's Sentry init.
//   sentry.server.config.ts reads SENTRY_DSN at runtime and logs one of two lines
//   at boot. BOTH strings must be in the compiled server output: if the DSN were
//   a build-time constant again (next.config.ts `env`), a DSN-less build folds
//   the condition and keeps only the "disabled" branch — the 07/10/2026 state, a
//   DSN in billing.env, a restart, and nothing ever reported.
// Usage: node scripts/check-sentry-build.mjs [server dir]   (default .next/server)
//   CI runs it right after its DSN-less build; after a deploy point it at
//   .deploy/current/.next/server. Reads files only, needs no DB.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { run, ok, fail, repoRoot } from './_check-lib.mjs';

const MARKERS = ['Sentry initialized', 'Sentry disabled (no DSN)'];

function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

run('check-sentry-build', async () => {
  const dir = resolve(repoRoot(), process.argv[2] ?? '.next/server');
  if (!existsSync(dir)) {
    fail(`אין תיקיית build ב-${dir} — הרץ npm run build קודם`);
    return;
  }
  const found = new Map(MARKERS.map((marker) => [marker, null]));
  for (const file of jsFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const marker of MARKERS) {
      if (!found.get(marker) && text.includes(marker)) found.set(marker, file);
    }
  }
  for (const [marker, file] of found) {
    if (file) ok(`"${marker}" נמצא בבנייה (${relative(dir, file)})`);
    else fail(`"${marker}" חסר בבנייה — אתחול Sentry בשרת לא קורא את ה-DSN בזמן ריצה (נאפה ב-build?)`);
  }
});
