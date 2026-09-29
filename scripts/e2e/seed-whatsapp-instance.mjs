#!/usr/bin/env node
// Seeds the ONE WhatsApp instance the e2e stack sends through, pointed at
// scripts/e2e/greenapi-stub.mjs.
//
// It is not in db/seed/e2e.sql because green_token_enc is an AES-256-GCM blob
// under SETTINGS_ENC_KEY, which plain SQL cannot produce. The few lines below
// write exactly the shape src/lib/crypto/settings-cipher.ts reads
// ({ iv, ct, tag }, all base64) — if that format ever changes, this fails
// loudly at the first send rather than silently sending nowhere.
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

function fromEnvFile(key) {
  try {
    const line = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
  } catch { return undefined; }
}

const DATABASE_URL = process.env.DATABASE_URL || fromEnvFile('DATABASE_URL');
const ENC_KEY = process.env.SETTINGS_ENC_KEY || fromEnvFile('SETTINGS_ENC_KEY');
const PORT = Number(process.env.E2E_GREENAPI_PORT ?? 3110);
const API_URL = `http://127.0.0.1:${PORT}`;

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!ENC_KEY) { console.error('SETTINGS_ENC_KEY not set'); process.exit(1); }

function encrypt(plaintext) {
  const key = Buffer.from(ENC_KEY, 'base64');
  if (key.length !== 32) { console.error('SETTINGS_ENC_KEY must decode to 32 bytes'); process.exit(1); }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  const admin = await pool.query(`select id from public.users where email = 'e2e-admin@billing.local' limit 1`);
  const userId = admin.rows[0]?.id
    ?? (await pool.query(`select id from public.users order by created_at limit 1`)).rows[0]?.id;
  if (!userId) { console.error('no user to own the instance — run the main seed first'); process.exit(1); }

  await pool.query(`delete from public.whatsapp_instances where green_instance_id = 'e2e-stub'`);
  await pool.query(
    `insert into public.whatsapp_instances
       (user_id, display_name, green_instance_id, green_token_enc, api_url, state)
     values ($1, 'E2E stub', 'e2e-stub', $2::jsonb, $3, 'authorized')`,
    [userId, JSON.stringify(encrypt('e2e-stub-token')), API_URL],
  );
  console.log(`e2e whatsapp instance seeded → ${API_URL}`);
} finally {
  await pool.end();
}
