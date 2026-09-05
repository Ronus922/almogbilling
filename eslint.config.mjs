// ESLint 9 flat config. Presets: eslint-config-next (core-web-vitals +
// typescript, the latter built on typescript-eslint). Two rules are promoted to
// `error` because CLAUDE.md iron rule 3 already mandates them: no `any`, no
// `console.*` (use src/lib/logger.ts). Nothing else is added on top of the
// presets' defaults.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

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
  {
    // CLI scripts and the vitest suite: stdout IS their interface (check:* output
    // is read by humans and by CI), so console is the right tool there.
    files: ['scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
]);
