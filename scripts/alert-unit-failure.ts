// scripts/alert-unit-failure.ts — OnFailure= handler: tell the admin, by email
// AND on WhatsApp, that a scheduled unit failed.
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
// TWO INDEPENDENT CHANNELS, email first then WhatsApp. Neither is allowed to
// stop the other: an SMTP outage must not swallow the WhatsApp alert, and a
// dead Green API instance must not swallow the email. Each result is logged;
// the process exits 1 only when BOTH failed, so the journal (and systemd) show
// that nobody was told.
//
// Env (from /etc/billing/billing.env): DATABASE_URL, SETTINGS_ENC_KEY,
// ADMIN_ALERT_EMAIL, ADMIN_ALERT_PHONE (falls back to BLLINK_ALERT_PHONE).
// Reads the DB only to look up the Green API instance and the SMTP account;
// writes nothing, anywhere.
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { sendAdminAlert } from './lib/admin-alert';
import { sendAdminEmail } from './lib/admin-email';
import { buildUnitFailureEmail, describeExit } from './lib/unit-failure';

dotenv.config({ path: '.env.local', quiet: true });

/** Email carries the fuller tail; WhatsApp is a phone screen, and Green API
 *  would truncate anything long anyway. */
const JOURNAL_LINES_EMAIL = 30;
const JOURNAL_LINES_WHATSAPP = 12;
/** Longest message we hand Green API. A journal tail is worth having, an
 *  unbounded one is worth nothing — the journal itself is the real record. */
const MAX_WHATSAPP_CHARS = 2500;

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

function journalTail(unit: string, invocationId: string, lines: number): string {
  // Scope to THIS invocation when systemd gave us one, so an alert never quotes
  // log lines from a previous, successful run.
  const args = invocationId
    ? ['-u', unit, `_SYSTEMD_INVOCATION_ID=${invocationId}`, '-n', String(lines), '--no-pager', '-o', 'cat']
    : ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat'];
  return sh('journalctl', args);
}

function lastLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n');
}

async function main(): Promise<void> {
  const unit = process.argv[2];
  if (!unit) throw new Error('usage: alert-unit-failure.ts <unit-name>');

  const p = props(unit);
  const result = p.Result || 'unknown';
  const exitStatus = describeExit(p.ExecMainCode, p.ExecMainStatus);
  const whenIso = new Date().toISOString();
  const journal = journalTail(unit, p.InvocationID ?? '', JOURNAL_LINES_EMAIL);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const db = new Client({ connectionString: url });
  await db.connect();

  let anySent = false;
  try {
    // ── 1. email ───────────────────────────────────────────────────────────
    try {
      const mail = buildUnitFailureEmail({ unit, result, exitStatus, whenIso, journal });
      const r = await sendAdminEmail(db, mail);
      anySent ||= r.sent;
      console.error(`[alert-unit-failure] ${unit}: ${r.detail}`);
    } catch (err) {
      console.error(`[alert-unit-failure] ${unit}: email alert FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── 2. WhatsApp ────────────────────────────────────────────────────────
    try {
      const text =
        `⚠️ יחידת systemd נכשלה (billing)\n` +
        `יחידה: ${unit}\n` +
        `תוצאה: ${result} — ${exitStatus}\n` +
        `זמן: ${whenIso}\n` +
        `\nיומן:\n${lastLines(journal, JOURNAL_LINES_WHATSAPP)}`;
      const r = await sendAdminAlert(db, text.slice(0, MAX_WHATSAPP_CHARS));
      anySent ||= r.sent;
      console.error(`[alert-unit-failure] ${unit}: ${r.detail}`);
    } catch (err) {
      console.error(`[alert-unit-failure] ${unit}: WhatsApp alert FAILED: ${err instanceof Error ? err.message : err}`);
    }
  } finally {
    await db.end();
  }

  if (!anySent) {
    console.error(`[alert-unit-failure] ${unit}: BOTH CHANNELS FAILED — nobody was told`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[alert-unit-failure] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
