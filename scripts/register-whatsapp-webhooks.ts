// register-whatsapp-webhooks.ts
// Operational tool: (re-)register the inbound Green API webhook on EVERY
// whatsapp_instances row, verify the settings took, probe the live state, and
// persist it. Fixes the "webhook points at the old app / never registered" root
// cause (Part A) for all instances at once.
//
// Run (loads the production env):
//   set -a; . /etc/billing/billing.env; set +a; npx tsx scripts/register-whatsapp-webhooks.ts
//
// Needs: DATABASE_URL, SETTINGS_ENC_KEY, GREEN_API_WEBHOOK_SECRET, APP_URL.

import { Client } from 'pg';
import { createDecipheriv } from 'node:crypto';

interface EncBlob { iv: string; ct: string; tag: string }

function decrypt(blob: EncBlob): string {
  const key = Buffer.from(process.env.SETTINGS_ENC_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENC_KEY must decode to 32 bytes');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

function webhookUrl(): string {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  const secret = (process.env.GREEN_API_WEBHOOK_SECRET ?? '').trim();
  if (!app) throw new Error('APP_URL not set');
  if (!secret) throw new Error('GREEN_API_WEBHOOK_SECRET not set');
  return `${app}/api/webhooks/greenapi?secret=${secret}`;
}

async function main() {
  const url = webhookUrl();
  const masked = url.replace(/(secret=)[^&]*/, '$1•••');
  console.log(`Webhook URL: ${masked}\n`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query<{
    id: string; display_name: string; green_instance_id: string;
    green_token_enc: EncBlob; api_url: string;
  }>(`select id, display_name, green_instance_id, green_token_enc, api_url
        from public.whatsapp_instances order by created_at asc`);

  if (rows.length === 0) {
    console.log('No instances found.');
    await client.end();
    return;
  }

  for (const r of rows) {
    const base = (r.api_url || 'https://api.green-api.com').replace(/\/+$/, '');
    const token = decrypt(r.green_token_enc);
    const tag = `${r.display_name} (idInstance=${r.green_instance_id})`;
    console.log(`── ${tag} ──`);

    // 1. setSettings — enable every notification the inbox needs.
    try {
      const res = await fetch(`${base}/waInstance${r.green_instance_id}/setSettings/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: url,
          incomingWebhook: 'yes',
          outgoingWebhook: 'yes',
          outgoingMessageWebhook: 'yes',
          outgoingAPIMessageWebhook: 'yes',
          stateWebhook: 'yes',
        }),
      });
      console.log(`  setSettings: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      console.log(`  setSettings FAILED: ${(e as Error).message}`);
    }

    // 2. getSettings — verify what actually took (Green reboots ~5s after set).
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const res = await fetch(`${base}/waInstance${r.green_instance_id}/getSettings/${token}`);
      const s = JSON.parse(await res.text()) as Record<string, unknown>;
      console.log(`  getSettings: webhookUrl=${(s.webhookUrl as string)?.replace(/(secret=)[^&]*/, '$1•••')} ` +
        `incoming=${s.incomingWebhook} outMsg=${s.outgoingMessageWebhook} outApi=${s.outgoingAPIMessageWebhook} state=${s.stateWebhook}`);
    } catch (e) {
      console.log(`  getSettings FAILED: ${(e as Error).message}`);
    }

    // 3. getStateInstance — persist the live connection state.
    try {
      const res = await fetch(`${base}/waInstance${r.green_instance_id}/getStateInstance/${token}`);
      const s = JSON.parse(await res.text()) as { stateInstance?: string };
      const state = s.stateInstance ?? 'unknown';
      console.log(`  state: ${state}`);
      const valid = ['notAuthorized', 'authorized', 'blocked', 'starting', 'yellowCard', 'sleepMode'];
      if (valid.includes(state)) {
        await client.query(
          `update public.whatsapp_instances set state = $2, state_checked_at = now() where id = $1`,
          [r.id, state],
        );
      }
    } catch (e) {
      console.log(`  getStateInstance FAILED: ${(e as Error).message}`);
    }
    console.log('');
  }

  await client.end();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
