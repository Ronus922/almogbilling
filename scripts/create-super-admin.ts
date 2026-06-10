// Usage: npx tsx scripts/create-super-admin.ts <email> "<full_name>" <password>
//
// Creates a super_admin user. Username is set to the email address (the
// post-Slice-6 convention). Run on the host with access to DIRECT_URL.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { Client } from 'pg';
import bcrypt from 'bcryptjs';

const [emailArg, fullNameArg, passwordArg] = process.argv.slice(2);
if (!emailArg || !fullNameArg || !passwordArg) {
  console.error('Usage: npx tsx scripts/create-super-admin.ts <email> "<full_name>" <password>');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const full_name = fullNameArg.trim();
const password = passwordArg;

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Invalid email');
  process.exit(1);
}
if (full_name.length < 2 || full_name.length > 80) {
  console.error('full_name must be 2-80 chars');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 chars');
  process.exit(1);
}

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
    const dup = await client.query<{ id: string }>(
      `select id from public.users where lower(username) = $1 or lower(email) = $1 limit 1`,
      [email],
    );
    if (dup.rows[0]) {
      console.error(`A user with email ${email} already exists (id=${dup.rows[0].id})`);
      process.exit(2);
    }

    const { rows } = await client.query<{ id: string; email: string; role: string }>(
      `insert into public.users (username, email, full_name, password_hash, role, is_active)
       values ($1, $2, $3, $4, 'super_admin', true)
       returning id, email, role`,
      [email, email, full_name, password_hash],
    );
    const u = rows[0];
    console.log(`✓ Created ${u.role} user ${u.id} (${u.email})`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
