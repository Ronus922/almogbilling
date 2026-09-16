// scripts/lib/unit-failure.ts — how a failed systemd unit is described to a
// human. Pure: no I/O, no systemd, no network, so tests can pin it.
//
// Both alert channels render from here (scripts/alert-unit-failure.ts):
// the email body in full, the WhatsApp message from the same pieces. Delivery
// lives in the sibling modules — admin-email.ts (SMTP) and admin-alert.ts
// (Green API).

export interface UnitFailure {
  unit: string;
  /** systemd's Result, e.g. `exit-code`, `timeout`, `oom-kill`. */
  result: string;
  /** Already in words — see describeExit(). */
  exitStatus: string;
  /** ISO-8601, UTC. Passed in so the body is a pure function of its inputs. */
  whenIso: string;
  journal: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * How the failure ended, in words rather than a bare number.
 *
 * systemd's ExecMainStatus describes the MAIN process, and `ExecMainCode=0`
 * means no main process ever ran — which is exactly what an ExecStartPre gate
 * refusing looks like. Reporting that as "exit 0" next to "failed" makes the
 * reader doubt the alert, so name it instead. ExecMainCode is an si_code:
 * 1 = CLD_EXITED, 2 = CLD_KILLED.
 */
export function describeExit(execMainCode: string | undefined, execMainStatus: string | undefined): string {
  if (!execMainCode || execMainCode === '0') return 'ExecStart never ran (a pre-condition refused)';
  if (execMainCode === '2') return `killed by signal ${execMainStatus ?? '?'}`;
  return `exit ${execMainStatus ?? '?'}`;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The alert body. A failure report that loses the unit name, the time or the
 * journal is worthless, and this is the only place those three are assembled.
 */
export function buildUnitFailureEmail(f: UnitFailure): BuiltEmail {
  const subject = `[billing] ${f.unit} נכשלה`;
  const text = [
    `יחידת systemd נכשלה על שרת billing.`,
    ``,
    `יחידה: ${f.unit}`,
    `תוצאה: ${f.result} — ${f.exitStatus}`,
    `זמן (UTC): ${f.whenIso}`,
    ``,
    `30 השורות האחרונות ביומן של אותה ריצה:`,
    ``,
    f.journal,
    ``,
    `journalctl -u ${f.unit} -n 100 --no-pager`,
  ].join('\n');

  const html = [
    `<div dir="rtl" style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.6">`,
    `<p><strong>יחידת systemd נכשלה על שרת billing.</strong></p>`,
    `<table cellpadding="6" style="border-collapse:collapse">`,
    `<tr><td><strong>יחידה</strong></td><td><code>${esc(f.unit)}</code></td></tr>`,
    `<tr><td><strong>תוצאה</strong></td><td>${esc(f.result)} — ${esc(f.exitStatus)}</td></tr>`,
    `<tr><td><strong>זמן (UTC)</strong></td><td>${esc(f.whenIso)}</td></tr>`,
    `</table>`,
    `<p style="margin-bottom:4px">30 השורות האחרונות ביומן של אותה ריצה:</p>`,
    `<pre dir="ltr" style="background:#f6f6f6;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${esc(f.journal)}</pre>`,
    `<p dir="ltr"><code>journalctl -u ${esc(f.unit)} -n 100 --no-pager</code></p>`,
    `</div>`,
  ].join('');

  return { subject, text, html };
}
