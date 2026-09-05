// ESLint 9 flat config. Presets: eslint-config-next (core-web-vitals +
// typescript, the latter built on typescript-eslint). Two rules are promoted to
// `error` because CLAUDE.md iron rule 3 already mandates them: no `any`, no
// `console.*` (use src/lib/logger.ts). Nothing else is added on top of the
// presets' defaults.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import safeql from '@ts-safeql/eslint-plugin/config';
import safeqlSqlOnly from './scripts/lint/eslint-plugin-safeql-sql-only.mjs';
import dotenv from 'dotenv';

// SafeQL validates every SQL string passed to query/queryOne/client.query/
// pool.query against the LIVE schema of DATABASE_URL (wrong table/column names,
// syntax errors, parameter count). The URL comes from the environment or from
// .env.local (never committed). Without a URL the SafeQL block is skipped and
// the rest of the lint still runs — CI always provides one.
dotenv.config({ path: '.env.local', quiet: true });
// SAFEQL=0 turns the SafeQL block off even when DATABASE_URL is available. The
// husky pre-push hook uses it: live-schema SQL validation is CI's job (see
// TESTING.md → "מה רץ איפה"). Every other rule in this config is unaffected.
const safeqlOff = process.env.SAFEQL === '0';
const databaseUrl = safeqlOff ? undefined : process.env.DATABASE_URL;
if (safeqlOff) {
  process.stderr.write('[eslint] SAFEQL=0 — SafeQL SQL validation skipped (runs in CI)\n');
} else if (!databaseUrl) {
  process.stderr.write('[eslint] DATABASE_URL not set — SafeQL SQL validation skipped\n');
}
// 'warn' while the existing queries are being cleaned up; 'error' once the
// count is 0 (infra(4)).
const SAFEQL_SEVERITY = 'error';
const safeqlConfig = databaseUrl
  ? [
      {
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
      },
      {
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        plugins: { 'safeql-sql-only': safeqlSqlOnly },
        rules: {
          // SafeQL's check-sql with the type-annotation reports filtered — see
          // scripts/lint/eslint-plugin-safeql-sql-only.mjs. Options are exactly
          // what @ts-safeql's connections() helper produces.
          'safeql-sql-only/check-sql': [
            SAFEQL_SEVERITY,
            safeql.configs.connections({
              databaseUrl,
              // Plain template literals passed to query/queryOne/client.query/
              // pool.query — see scripts/lint/safeql-pg-plugin.ts.
              plugins: [{ package: './scripts/lint/safeql-pg-plugin.ts' }],
            }).rules['@ts-safeql/check-sql'][1],
          ],
        },
      },
    ]
  : [];

export default defineConfig([
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'public/**',
    'work/**',
    'db/**',
    'next-env.d.ts',
    '.husky/**',
  ]),
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      // eslint-plugin-react-hooks v7 (React Compiler era) ships these as errors.
      // The existing UI has 105 findings in 63 files that need component
      // refactors — not an infra change. Kept visible as warnings; tracked in
      // docs/TECH_DEBT.md. New code should not add to the count.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  ...safeqlConfig,
  {
    // CLI scripts and the vitest suite: stdout IS their interface (check:* output
    // is read by humans and by CI), so console is the right tool there.
    files: ['scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
]);
