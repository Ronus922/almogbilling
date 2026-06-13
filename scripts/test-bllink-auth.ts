// scripts/test-bllink-auth.ts — standalone Cognito SRP auth check.
//
// Reads BLLINK_USERNAME / BLLINK_PASSWORD from the environment and runs srpAuth.
//   - missing creds  → prints a notice, exits 1 (expected until creds are set)
//   - success        → prints token[0:20] + length
//   - auth error     → prints the exact error message, exits 1
//
// Run (creds live in /etc/billing/billing.env, not the dotenv files):
//   eval "$(sudo sed -n 's/^\(BLLINK_USERNAME\|BLLINK_PASSWORD\)=/export \1=/p' /etc/billing/billing.env)" \
//     ; npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/test-bllink-auth.ts
//
// The server-only guard in cognito-srp.ts is stubbed via tsconfig.scripts.json.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { srpAuth } from '@/lib/bllink/cognito-srp';

async function main(): Promise<number> {
  const username = process.env.BLLINK_USERNAME;
  const password = process.env.BLLINK_PASSWORD;

  if (!username || !password) {
    console.log('BLLINK_USERNAME/PASSWORD not set');
    return 1;
  }

  try {
    const token = await srpAuth(username, password);
    console.log('AUTH SUCCESS');
    console.log('token[0:20]:', token.slice(0, 20));
    console.log('token length:', token.length);
    return 0;
  } catch (e) {
    console.error('AUTH ERROR:', e instanceof Error ? e.message : String(e));
    return 1;
  }
}

main().then((code) => process.exit(code));
