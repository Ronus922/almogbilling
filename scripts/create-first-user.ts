// Usage: npx tsx scripts/create-first-user.ts <username> <email> <password>
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { Client } from 'pg';
import bcrypt from 'bcryptjs';

const [username, email, password] = process.argv.slice(2);
if (!username || !email || !password) {
  console.error('Usage: npx tsx scripts/create-first-user.ts <username> <email> <password>');
  process.exit(1);
}

// One-shot script: prefer DIRECT_URL (session pooler 5432). The runtime app uses
// DATABASE_URL (transaction pooler 6543) via src/lib/db.ts.
const connectionString = process.env.DIRECT_URL;
if (!connectionString) {
  console.error('Missing DIRECT_URL in .env.local');
  process.exit(1);
}

async function main() {
  const password_hash = await bcrypt.hash(password, 10);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; username: string; email: string }>(
      `insert into public.users (username, email, password_hash)
       values ($1, $2, $3)
       returning id, username, email`,
      [username.toLowerCase(), email.toLowerCase(), password_hash],
    );
    const u = rows[0];
    console.log(`✓ Created user ${u.id} (${u.username} / ${u.email})`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
