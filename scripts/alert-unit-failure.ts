// scripts/alert-unit-failure.ts — OnFailure= handler: tell the admin, on
// WhatsApp, that a scheduled unit failed.
//
//   npx tsx scripts/alert-unit-failure.ts billing-backup.service
//
// Wired as `OnFailure=billing-alert@%n.service` on the units that must never
// fail silently (deploy/systemd/billing-alert@.service). systemd expands %n to
// the failing unit's own name, which arrives here as argv[2].
//
// WHY A UNIT-LEVEL HANDLER AND NOT A try/catch INSIDE EACH JOB: a job can only
// report a failure it survives. OnFailure also covers the cases it cannot — an
// ExecStartPre gate that refused to let it start, the TimeoutStartSec kill, an
// OOM kill, a syntax error that stops the process before its own error handling
// is wired. Those are exactly the silent failures prerequisite #2 was about.
//
// Env (from /etc/billing/billing.env): DATABASE_URL, SETTINGS_ENC_KEY,
// ADMIN_ALERT_PHONE (or BLLINK_ALERT_PHONE). Reads the DB only to look up the
// Green API instance; writes nothing, anywhere.
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { sendAdminAlert } from './lib/admin-alert';

dotenv.config({ path: '.env.local', quiet: true });

/** Longest message we hand Green API. A journal tail is worth having, an
 *  unbounded one is worth nothing — the journal itself is the real record. */
const MAX_MESSAGE_CHARS = 2500;
const JOURNAL_LINES = 12;

function sh(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' && out.trim() !== '' ? out.trim() : `<${file} failed>`;
  }
}

function props(unit: string): Record<string, string> {
  const raw = sh('systemctl', ['show', unit, '--property=Result,ExecMainStatus,ExecMainCode,InvocationID,ActiveEnterTimestamp']);
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function journalTail(unit: string, invocationId: string): string {
  // Scope to THIS invocation when systemd gave us one, so an alert never quotes
  // log lines from a previous, successful run.
  const args = invocationId
    ? ['-u', unit, `_SYSTEMD_INVOCATION_ID=${invocationId}`, '-n', String(JOURNAL_LINES), '--no-pager', '-o', 'cat']
    : ['-u', unit, '-n', String(JOURNAL_LINES), '--no-pager', '-o', 'cat'];
  return sh('journalctl', args);
}

async function main(): Promise<void> {
  const unit = process.argv[2];
  if (!unit) throw new Error('usage: alert-unit-failure.ts <unit-name>');

  const p = props(unit);
  const tail = journalTail(unit, p.InvocationID ?? '');

  const head =
    `⚠️ יחידת systemd נכשלה (billing)\n` +
    `יחידה: ${unit}\n` +
    `תוצאה: ${p.Result || 'unknown'} (exit ${p.ExecMainStatus ?? '?'})\n` +
    `זמן: ${new Date().toISOString()}\n` +
    `\nיומן:\n`;
  const message = (head + tail).slice(0, MAX_MESSAGE_CHARS);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const r = await sendAdminAlert(db, message);
    console.error(`[alert-unit-failure] ${unit}: ${r.detail}`);
    if (!r.sent) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`[alert-unit-failure] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
