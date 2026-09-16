// scripts/lib/unit-failure.ts — turns a failed systemd unit into a message a
// human can act on. Pure: no I/O, no systemd, no network, so tests pin it.
//
// The rule that shapes everything here: the reader is not on call and does not
// know what a unit is. They need, in this order — what broke, what it means,
// whether it matters tonight, and the one thing to do. Unit names, exit codes
// and journal text are evidence for afterwards, so they go last, below a rule.
//
// Both channels render from here (scripts/alert-unit-failure.ts); delivery is
// in the siblings admin-email.ts (SMTP) and admin-alert.ts (Green API).

/** Everything the script could learn about the failure. */
export interface FailureFacts {
  unit: string;
  /** systemd's Result: exit-code, timeout, oom-kill, signal, core-dump… */
  result: string;
  /** Which Exec* step actually failed, e.g. 'ExecStartPre'. Null if unknown. */
  failingStep: string | null;
  /** The failing step's own exit status — NOT ExecMainStatus. See readExitStatus(). */
  exitStatus: number | null;
  /** When the alert fired, ISO-8601 UTC. */
  whenIso: string;
  /** Journal of that invocation, newest last. */
  journal: string;
  /** Newest Storage snapshot, as the gate itself reported it. */
  snapshotIso: string | null;
  /** Last time this unit finished successfully. */
  lastGoodIso: string | null;
  /** When the timer will try again. */
  nextRunIso: string | null;
  /** A deliberate drill, not a real fault (ALERT_TEST_MODE=1). */
  testMode: boolean;
}

export type Cause =
  | 'storage_snapshot_stale'
  | 'storage_snapshot_missing'
  | 'restic_failed'
  | 'pg_dump_failed'
  | 'cleanup_job_failed'
  | 'timeout'
  | 'oom'
  | 'unknown';

export interface Explanation {
  title: string;
  what: string;
  urgency: string;
  action: string;
}

// ── time ─────────────────────────────────────────────────────────────────────

/** Israel local time — the only clock the reader thinks in. `?` when unknown. */
export function ilTime(iso: string | null): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(', ', ' ');
}

/** Just the clock part, for "ינסה שוב מחר ב-07:30". */
export function ilClock(iso: string | null): string {
  const full = ilTime(iso);
  return full === '?' ? '?' : full.split(' ')[1];
}

function daysSince(iso: string | null, nowIso: string): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.floor((now - then) / 86_400_000);
}

// ── reading systemd ──────────────────────────────────────────────────────────

/** Exec* steps in the order systemd runs them; later beats earlier. */
const EXEC_STEPS = ['ExecStartPre', 'ExecStart', 'ExecStartPost'] as const;

/**
 * THE EXIT CODE, from the step that actually failed — parsed out of the raw
 * `systemctl show -p ExecStartPre,ExecStart,ExecStartPost` text.
 *
 * `ExecMainStatus` describes the MAIN process only. When an ExecStartPre gate
 * refuses, no main process ever runs, so systemd reports ExecMainCode=0 and
 * ExecMainStatus=0 — and an alert that trusts it says "failed … exit 0", a
 * contradiction that makes the reader doubt the whole message. The truth is in
 * the structured properties:
 *
 *   ExecStartPre={ … start_time=[Wed …] ; code=exited ; status=1 }
 *   ExecStart=   { … start_time=[n/a]   ; code=(null) ; status=0/0 }
 *
 * Two traps, both of which produced wrong alerts before they were fixed:
 *   • a step with several commands is printed as SEVERAL LINES SHARING ONE KEY,
 *     so a naive key→value map keeps only the last and loses the failure;
 *   • `status=0/0` on a step that never ran must not be read as "exited 0".
 *
 * So: every entry that RAN (start_time is not `[n/a]`) and ended non-zero is a
 * candidate, and the one from the latest step wins.
 */
export function parseExecStatus(showOutput: string): { step: string | null; status: number | null } {
  let best: { step: string; status: number; rank: number } | null = null;

  for (const line of showOutput.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const rank = (EXEC_STEPS as readonly string[]).indexOf(key);
    if (rank === -1) continue;

    const entry = line.slice(eq + 1);
    if (/start_time=\[n\/a\]/.test(entry)) continue; // never ran
    const m = entry.match(/status=(\d+)/);
    if (!m) continue;
    const status = Number(m[1]);
    if (status === 0) continue;
    if (!best || rank >= best.rank) best = { step: key, status, rank };
  }

  return best ? { step: best.step, status: best.status } : { step: null, status: null };
}

/**
 * The newest successful completion in raw `journalctl` output. systemd logs
 * "Finished <unit>" only on success, so the newest one is the last good run.
 *
 * Takes the MAXIMUM rather than the first or last line on purpose: `journalctl
 * -g` prints newest-first here, and reading it as oldest-first once reported a
 * backup as nine days stale when it had in fact run that afternoon.
 */
export function latestFinishedIso(journalOutput: string): string | null {
  let newest: number | null = null;
  let newestIso: string | null = null;
  for (const line of journalOutput.split('\n')) {
    if (!line.includes('Finished ')) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z))/);
    if (!m) continue;
    const t = new Date(m[1]).getTime();
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) { newest = t; newestIso = new Date(t).toISOString(); }
  }
  return newestIso;
}

// ── what went wrong ──────────────────────────────────────────────────────────

/** The Storage snapshot time out of the gate's own refusal line. */
export function snapshotIsoFromJournal(journal: string): string | null {
  const m = journal.match(/snapshot \([0-9a-f]+, ([0-9T:+\-.]+Z?|[0-9T:+\-.]+)\)/);
  return m ? m[1] : null;
}

export function classify(f: FailureFacts): Cause {
  if (f.result === 'oom-kill') return 'oom';
  if (f.result === 'timeout') return 'timeout';

  const j = f.journal;
  if (/assert-storage-snapshot/.test(j) && /REFUSING/.test(j)) {
    return /no snapshot tagged/.test(j) ? 'storage_snapshot_missing' : 'storage_snapshot_stale';
  }
  if (/\[restic-push\] ERROR/.test(j)) return 'restic_failed';
  if (/\[pg-backup\] ERROR/.test(j)) return 'pg_dump_failed';
  if (f.unit.startsWith('billing-storage-cleanup') && f.failingStep === 'ExecStart') return 'cleanup_job_failed';
  return 'unknown';
}

/** True when the nightly dumps were written before the failure — the off-site
 *  push is the only thing missing, which changes how urgent this is. */
function localDumpsWritten(journal: string): boolean {
  return /\[pg-backup\] done:/.test(journal);
}

function retryLine(f: FailureFacts): string {
  const at = ilClock(f.nextRunIso);
  return at === '?' ? 'ינסה שוב בריצה הבאה.' : `ינסה שוב מחר ב-${at}.`;
}

export function explain(f: FailureFacts): Explanation {
  const cause = classify(f);
  const since = daysSince(f.lastGoodIso, f.whenIso);

  switch (cause) {
    case 'storage_snapshot_stale':
    case 'storage_snapshot_missing': {
      const when = cause === 'storage_snapshot_missing'
        ? 'לא נמצא בכלל גיבוי של הקבצים'
        : `הגיבוי האחרון של הקבצים הוא מ-${ilTime(f.snapshotIso)}`;
      return {
        title: 'ניקוי הקבצים לא רץ הלילה',
        what:
          'הניקוי הלילי לא רץ כי הגיבוי של הקבצים לא בוצע הלילה. ' +
          'המערכת עצרה את עצמה בכוונה כדי לא למחוק קובץ שאין ממנו גיבוי. ' +
          'שום קובץ לא נמחק.',
        urgency: `לא דחוף. המערכת עובדת רגיל. ${when}.`,
        action:
          `אין צורך לעשות כלום — ${retryLine(f)} ` +
          'אם ההודעה הזו חוזרת גם מחר, סימן שהגיבוי הלילי עצמו לא עובד, ואז כן צריך לבדוק.',
      };
    }

    case 'restic_failed': {
      const local = localDumpsWritten(f.journal);
      return {
        title: 'הגיבוי הלילי לא הועלה לענן',
        what:
          'הגיבוי הלילי נשמר על השרת, אבל ההעלאה שלו לאחסון החיצוני נכשלה. ' +
          'כלומר יש עותק אחד, על אותו שרת — ואין עותק מחוץ לו.',
        urgency: local
          ? `לא דחוף הלילה, אבל לא להתעלם. הגיבוי המלא האחרון מחוץ לשרת הוא מ-${ilTime(f.lastGoodIso)}.`
          : `דחוף. אין גיבוי תקין מאז ${ilTime(f.lastGoodIso)}.`,
        action:
          `${retryLine(f)} אם זה חוזר גם מחר — צריך לבדוק את החיבור לאחסון החיצוני, ` +
          'כי מאותו רגע אין עותק מחוץ לשרת.',
      };
    }

    case 'pg_dump_failed':
      return {
        title: 'הגיבוי הלילי לא הצליח',
        what:
          'הגיבוי הלילי של מסד הנתונים לא רץ. זה הגיבוי שמכיל את כל הנתונים של המערכת — ' +
          'דיירים, חיובים, תשלומים והודעות.',
        urgency:
          since !== null && since >= 2
            ? `דחוף. המערכת לא מגובה מאז ${ilTime(f.lastGoodIso)} — ${since} ימים.`
            : `המערכת עובדת רגיל, אבל הגיבוי האחרון הוא מ-${ilTime(f.lastGoodIso)}.`,
        action: `${retryLine(f)} אם זה נכשל גם מחר — צריך לבדוק, כי אז אין גיבוי עדכני.`,
      };

    case 'cleanup_job_failed':
      return {
        title: 'ניקוי הקבצים לא רץ הלילה',
        what:
          'הניקוי הלילי של קבצים ישנים התחיל ונעצר באמצע. ' +
          'הוא רץ במצב בדיקה בלבד ואינו מוחק כלום, אז שום קובץ לא נפגע.',
        urgency: 'לא דחוף. המערכת עובדת רגיל.',
        action: `אין צורך לעשות כלום — ${retryLine(f)}`,
      };

    case 'timeout':
      return {
        title: 'משימה לילית נתקעה ונעצרה',
        what: 'משימה לילית רצה יותר מדי זמן והמערכת עצרה אותה. היא לא סיימה את העבודה שלה.',
        urgency: 'לא דחוף אם זה קרה פעם אחת. המערכת עצמה עובדת רגיל.',
        action: `${retryLine(f)} אם זה חוזר — צריך לבדוק למה זה נתקע.`,
      };

    case 'oom':
      return {
        title: 'משימה לילית נעצרה מחוסר זיכרון',
        what: 'לשרת נגמר הזיכרון והמערכת הפסיקה משימה לילית באמצע כדי להישאר יציבה.',
        urgency: 'לא דחוף מיידית, אבל אם זה חוזר זה סימן שהשרת צפוף.',
        action: `${retryLine(f)} אם זה חוזר — צריך לבדוק את הזיכרון בשרת.`,
      };

    default:
      return {
        title: 'משימה לילית נכשלה',
        what: 'משהו נכשל ואני לא יודע להסביר מה. הפרטים הטכניים למטה.',
        urgency: 'לא ידוע. אם המערכת עובדת רגיל מבחינתך — כנראה לא דחוף.',
        action: `${retryLine(f)} אם ההודעה חוזרת — כדאי להעביר את הפרטים שלמטה למי שמתחזק את המערכת.`,
      };
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

const RULE = '──────────────';

function titleOf(f: FailureFacts, e: Explanation): string {
  return f.testMode ? `[בדיקה] ${e.title}` : e.title;
}

function testNote(f: FailureFacts): string[] {
  return f.testMode
    ? ['זו בדיקה מכוונת של מערכת ההתראות, לא תקלה אמיתית. לא צריך לעשות כלום.', '']
    : [];
}

function techLines(f: FailureFacts): string[] {
  const exit = f.exitStatus === null ? '—' : String(f.exitStatus);
  const step = f.failingStep ? ` (${f.failingStep})` : '';
  return [
    `יחידה: ${f.unit}`,
    `זמן: ${ilTime(f.whenIso)} (שעון ישראל)`,
    `קוד יציאה: ${exit}${step} · ${f.result}`,
  ];
}

/** WhatsApp: the four human parts, then ONE journal line — a phone screen. */
export function buildWhatsApp(f: FailureFacts): string {
  const e = explain(f);
  const lastJournalLine = f.journal.split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? '—';
  return [
    titleOf(f, e),
    '',
    ...testNote(f),
    e.what,
    '',
    e.urgency,
    '',
    e.action,
    '',
    RULE,
    ...techLines(f),
    lastJournalLine,
  ].join('\n');
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Email: the same four parts, then the last 30 journal lines. */
export function buildEmail(f: FailureFacts): BuiltEmail {
  const e = explain(f);
  const subject = f.testMode ? `[בדיקה] ${e.title}` : e.title;

  const text = [
    titleOf(f, e),
    '',
    ...testNote(f),
    e.what,
    '',
    e.urgency,
    '',
    e.action,
    '',
    RULE,
    ...techLines(f),
    '',
    '30 השורות האחרונות ביומן של אותה ריצה:',
    '',
    f.journal || '(היומן ריק)',
    '',
    `journalctl -u ${f.unit} -n 100 --no-pager`,
  ].join('\n');

  const html = [
    `<div dir="rtl" style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.7;max-width:640px">`,
    `<h2 style="margin:0 0 16px;font-size:19px">${esc(titleOf(f, e))}</h2>`,
    ...(f.testMode
      ? [`<p style="background:#fff8e1;padding:10px 12px;margin:0 0 16px">זו בדיקה מכוונת של מערכת ההתראות, לא תקלה אמיתית. לא צריך לעשות כלום.</p>`]
      : []),
    `<p style="margin:0 0 14px">${esc(e.what)}</p>`,
    `<p style="margin:0 0 14px"><strong>${esc(e.urgency)}</strong></p>`,
    `<p style="margin:0 0 20px">${esc(e.action)}</p>`,
    `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">`,
    `<p style="margin:0 0 10px;color:#666;font-size:13px">פרטים טכניים</p>`,
    `<table cellpadding="4" style="border-collapse:collapse;font-size:13px;color:#444">`,
    `<tr><td>יחידה</td><td dir="ltr"><code>${esc(f.unit)}</code></td></tr>`,
    `<tr><td>זמן (שעון ישראל)</td><td>${esc(ilTime(f.whenIso))}</td></tr>`,
    `<tr><td>קוד יציאה</td><td dir="ltr">${esc(f.exitStatus === null ? '—' : String(f.exitStatus))}${esc(f.failingStep ? ` (${f.failingStep})` : '')} · ${esc(f.result)}</td></tr>`,
    `</table>`,
    `<p style="margin:16px 0 4px;color:#666;font-size:13px">30 השורות האחרונות ביומן של אותה ריצה:</p>`,
    `<pre dir="ltr" style="background:#f6f6f6;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:12px">${esc(f.journal || '(empty)')}</pre>`,
    `<p dir="ltr" style="font-size:12px"><code>journalctl -u ${esc(f.unit)} -n 100 --no-pager</code></p>`,
    `</div>`,
  ].join('');

  return { subject, text, html };
}
