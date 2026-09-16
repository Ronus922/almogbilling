// scripts/alert-unit-failure.ts — OnFailure= handler: tell the admin, by email
// AND on WhatsApp, that a scheduled job failed — in language they can act on.
//
//   npx tsx scripts/alert-unit-failure.ts billing-backup.service
//   npx tsx scripts/alert-unit-failure.ts <unit> --print   # render, send nothing
//   ALERT_TEST_MODE=1 npx tsx scripts/alert-unit-failure.ts <unit>   # drill
//
// Wired as `OnFailure=billing-alert@%n.service` on the units that must never
// fail silently (deploy/systemd/billing-alert@.service). systemd expands %n to
// the failing unit's own name, which arrives here as argv[2].
//
// WHY A UNIT-LEVEL HANDLER AND NOT A try/catch INSIDE EACH JOB: a job can only
// report a failure it survives. OnFailure also covers the cases it cannot — an
// ExecStartPre gate that refused to let it start, the TimeoutStartSec kill, an
// OOM kill, a syntax error that stops the process before its own error handling
// is wired.
//
// TWO INDEPENDENT CHANNELS, email first then WhatsApp. Neither is allowed to
// stop the other: an SMTP outage must not swallow the WhatsApp alert, and a
// dead Green API instance must not swallow the email. Each result is logged;
// the process exits 1 only when BOTH failed, so the journal (and systemd) show
// that nobody was told.
//
// This file only GATHERS FACTS. Every word the reader sees is built in
// scripts/lib/unit-failure.ts, which is pure and tested.
//
// Env (from /etc/billing/billing.env): DATABASE_URL, SETTINGS_ENC_KEY,
// ADMIN_ALERT_EMAIL, ADMIN_ALERT_PHONE (falls back to BLLINK_ALERT_PHONE),
// ALERT_TEST_MODE. Reads the DB only to look up the Green API instance and the
// SMTP account; writes nothing, anywhere.
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { sendAdminAlert } from './lib/admin-alert';
import { sendAdminEmail } from './lib/admin-email';
import {
  buildEmail, buildWhatsApp, latestFinishedIso, parseExecStatus, snapshotIsoFromJournal,
  type FailureFacts,
} from './lib/unit-failure';

dotenv.config({ path: '.env.local', quiet: true });

/** Email carries the fuller tail; WhatsApp is a phone screen. */
const JOURNAL_LINES = 30;
/** Longest message we hand Green API. */
const MAX_WHATSAPP_CHARS = 2500;

function sh(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' && out.trim() !== '' ? out.trim() : '';
  }
}

/** systemctl show output → key→value. Exec* steps with several commands are
 *  printed as several lines sharing one key, so repeated keys are JOINED, never
 *  overwritten — dropping one loses the command that actually failed. */
function showProps(unit: string, properties: string[]): Record<string, string> {
  const raw = sh('systemctl', ['show', unit, `--property=${properties.join(',')}`]);
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    out[key] = key in out ? `${out[key]}\n${line}` : line;
  }
  return out;
}

/** The failing step and its exit status. Falls back to the main process for a
 *  signal or OOM kill, where no Exec* entry carries a non-zero status. */
function readExitStatus(unit: string): { step: string | null; status: number | null } {
  const raw = sh('systemctl', ['show', unit, '--property=ExecStartPre,ExecStart,ExecStartPost']);
  const fromSteps = parseExecStatus(raw);
  if (fromSteps.status !== null) return fromSteps;

  const main = sh('systemctl', ['show', unit, '--property=ExecMainCode,ExecMainStatus']);
  const code = main.match(/ExecMainCode=(\d+)/)?.[1];
  const status = main.match(/ExecMainStatus=(\d+)/)?.[1];
  if (code && code !== '0') return { step: null, status: Number(status ?? 0) };
  return { step: null, status: null };
}

function journalTail(unit: string, invocationId: string, lines: number): string {
  // Scope to THIS invocation when systemd gave us one, so an alert never quotes
  // log lines from a previous, successful run.
  const args = invocationId
    ? ['-u', unit, `_SYSTEMD_INVOCATION_ID=${invocationId}`, '-n', String(lines), '--no-pager', '-o', 'cat']
    : ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat'];
  return sh('journalctl', args);
}

/** When this unit last FINISHED successfully. */
function lastGoodRunIso(unit: string): string | null {
  return latestFinishedIso(
    sh('journalctl', ['-u', unit, '--no-pager', '-o', 'short-iso', '-n', '2000', '-g', 'Finished ']),
  );
}

/** When the timer will try again. */
function nextRunIso(unit: string): string | null {
  const timer = unit.replace(/\.service$/, '.timer');
  const raw = sh('systemctl', ['show', timer, '--property=NextElapseUSecRealtime']);
  const value = raw.split('=').slice(1).join('=').trim();
  if (!value || value === 'n/a') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function main(): Promise<void> {
  const unit = process.argv[2];
  if (!unit) throw new Error('usage: alert-unit-failure.ts <unit-name> [--print]');
  // --print renders exactly what would be sent and sends nothing: for reviewing
  // the wording, and for checking after the fact what an alert actually said.
  const printOnly = process.argv.includes('--print');

  const base = showProps(unit, ['Result', 'InvocationID']);
  const valueOf = (k: string): string => (base[k] ?? '').slice(k.length + 1);
  const journal = journalTail(unit, valueOf('InvocationID'), JOURNAL_LINES);
  const { step, status } = readExitStatus(unit);

  const facts: FailureFacts = {
    unit,
    result: valueOf('Result') || 'unknown',
    failingStep: step,
    exitStatus: status,
    whenIso: new Date().toISOString(),
    journal,
    snapshotIso: snapshotIsoFromJournal(journal),
    lastGoodIso: lastGoodRunIso(unit),
    nextRunIso: nextRunIso(unit),
    testMode: process.env.ALERT_TEST_MODE === '1',
  };

  if (printOnly) {
    const mail = buildEmail(facts);
    process.stdout.write(`--- WhatsApp ---\n${buildWhatsApp(facts)}\n\n`);
    process.stdout.write(`--- email: ${mail.subject} ---\n${mail.text}\n`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const db = new Client({ connectionString: url });
  await db.connect();

  let anySent = false;
  try {
    // ── 1. email ───────────────────────────────────────────────────────────
    try {
      const r = await sendAdminEmail(db, buildEmail(facts));
      anySent ||= r.sent;
      console.error(`[alert-unit-failure] ${unit}: ${r.detail}`);
    } catch (err) {
      console.error(`[alert-unit-failure] ${unit}: email alert FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── 2. WhatsApp ────────────────────────────────────────────────────────
    try {
      const r = await sendAdminAlert(db, buildWhatsApp(facts).slice(0, MAX_WHATSAPP_CHARS));
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
