import { describe, expect, it } from 'vitest';
import {
  buildEmail,
  buildWhatsApp,
  classify,
  explain,
  ilTime,
  latestFinishedIso,
  parseExecStatus,
  snapshotIsoFromJournal,
  type FailureFacts,
} from '../scripts/lib/unit-failure';

// The alert exists to be ACTED ON by someone who does not know what a systemd
// unit is. These pin the contract: plain Hebrew first, urgency stated, one
// concrete action, and the technical evidence last — never a unit name or an
// exit code where the explanation should be.

const GATE_JOURNAL =
  "2026-09-17 04:30:02 [assert-storage-snapshot] REFUSING: the newest 'storage' snapshot " +
  "(3f820c36, 2026-09-16T17:22:36+00:00) is 35.1h old, limit 26h — today's Storage bytes " +
  'are not backed up; not touching anything';

const base: FailureFacts = {
  unit: 'billing-storage-cleanup.service',
  result: 'exit-code',
  failingStep: 'ExecStartPre',
  exitStatus: 1,
  whenIso: '2026-09-17T01:30:05.000Z',
  journal: GATE_JOURNAL,
  snapshotIso: '2026-09-16T17:22:36+00:00',
  lastGoodIso: '2026-09-16T18:20:00.000Z',
  nextRunIso: '2026-09-18T04:30:00.000Z',
  testMode: false,
};

describe('ilTime — the reader thinks in Israel time, never UTC', () => {
  it('converts UTC to Israel local', () => {
    // 17:22 UTC in September is 20:22 in Jerusalem (UTC+3).
    expect(ilTime('2026-09-16T17:22:36+00:00')).toBe('16/09/2026 20:22');
  });
  it('never renders an unparseable or missing time as a fake one', () => {
    expect(ilTime(null)).toBe('?');
    expect(ilTime('not a date')).toBe('?');
  });
});

describe('classify', () => {
  const f = (over: Partial<FailureFacts>): FailureFacts => ({ ...base, ...over });

  it('recognises the Storage gate refusing', () => {
    expect(classify(base)).toBe('storage_snapshot_stale');
  });
  it('tells "no snapshot at all" apart from "stale snapshot"', () => {
    expect(classify(f({ journal: "[assert-storage-snapshot] REFUSING: no snapshot tagged 'storage' exists" })))
      .toBe('storage_snapshot_missing');
  });
  it('recognises the off-site push and the dump separately', () => {
    expect(classify(f({ unit: 'billing-backup.service', journal: '[restic-push] ERROR: aborted at line 80' }))).toBe('restic_failed');
    expect(classify(f({ unit: 'billing-backup.service', journal: '[pg-backup] ERROR: container not found' }))).toBe('pg_dump_failed');
  });
  it('lets systemd-level results win over journal text', () => {
    expect(classify(f({ result: 'timeout' }))).toBe('timeout');
    expect(classify(f({ result: 'oom-kill' }))).toBe('oom');
  });
  it('recognises the Bllink scraper by unit name, whatever the step or journal text', () => {
    expect(classify(f({ unit: 'billing-bllink-scrape.service', journal: '', failingStep: 'ExecStart' }))).toBe('bllink_scrape_failed');
    expect(classify(f({ unit: 'billing-bllink-scrape.service', journal: '[bllink:shadow] run=x FAILED stage=login: net::ERR', failingStep: null }))).toBe('bllink_scrape_failed');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classify(f({ journal: 'something nobody has seen before', failingStep: null }))).toBe('unknown');
  });
});

describe('explain', () => {
  it('the gate refusal reassures that nothing was deleted, and dates the last backup', () => {
    const e = explain(base);
    expect(e.title).toBe('ניקוי הקבצים לא רץ הלילה');
    expect(e.what).toContain('שום קובץ לא נמחק');
    expect(e.urgency).toContain('לא דחוף');
    expect(e.urgency).toContain('16/09/2026 20:22');
    expect(e.action).toContain('אין צורך לעשות כלום');
  });

  it('names the retry time in Israel local time', () => {
    expect(explain(base).action).toContain('07:30'); // 04:30 UTC
  });

  it('a database backup missing for days is called urgent, one night is not', () => {
    const dump = { ...base, unit: 'billing-backup.service', journal: '[pg-backup] ERROR: boom' };
    expect(explain({ ...dump, lastGoodIso: '2026-09-16T18:00:00Z' }).urgency).not.toContain('דחוף.');
    expect(explain({ ...dump, lastGoodIso: '2026-09-10T18:00:00Z' }).urgency).toContain('דחוף');
  });

  it('an off-site push that failed after the local dumps says so, and is not called urgent', () => {
    const e = explain({
      ...base, unit: 'billing-backup.service',
      journal: '[pg-backup] done: cluster-20260917.sql.gz\n[restic-push] ERROR: aborted at line 80',
    });
    expect(e.title).toContain('לא הועלה לענן');
    expect(e.urgency).toContain('לא דחוף הלילה');
  });

  it('a failed Bllink scrape says nothing changed, dates the last good scrape, and escalates after two days', () => {
    const scrape = { ...base, unit: 'billing-bllink-scrape.service', journal: '[bllink:shadow] run=x FAILED stage=login: boom', failingStep: 'ExecStart' as const };
    const once = explain({ ...scrape, lastGoodIso: '2026-09-16T03:10:00Z' });
    expect(once.title).toBe('סריקת החובות מבלינק נכשלה');
    expect(once.what).toContain('שום נתון לא נמחק ולא שונה');
    expect(once.urgency).toContain('לא דחוף');
    expect(once.urgency).toContain('16/09/2026 06:10');
    expect(once.action).toContain('/var/log/billing');
    const days = explain({ ...scrape, lastGoodIso: '2026-09-13T03:10:00Z' }); // 3 days 22h before whenIso
    expect(days.urgency).toContain('דחוף.');
    expect(days.urgency).toContain('3 ימים');
  });

  it('an unknown failure admits it rather than inventing a cause', () => {
    const e = explain({ ...base, journal: 'mystery', failingStep: null });
    expect(e.what).toContain('אני לא יודע להסביר מה');
  });
});

describe('message shape', () => {
  it('WhatsApp leads with plain Hebrew and keeps the unit name out of the headline', () => {
    const msg = buildWhatsApp(base);
    const firstLine = msg.split('\n')[0];
    expect(firstLine).toBe('ניקוי הקבצים לא רץ הלילה');
    expect(firstLine).not.toContain('billing-storage-cleanup');
    expect(firstLine).not.toContain('.service');
  });

  it('technical details come last, below the rule, in Israel time', () => {
    const msg = buildWhatsApp(base);
    const [human, tech] = msg.split('──────────────');
    expect(human).not.toContain('billing-storage-cleanup.service');
    expect(tech).toContain('billing-storage-cleanup.service');
    expect(tech).toContain('שעון ישראל');
    expect(tech).toContain('קוד יציאה: 1');
    expect(tech).not.toContain('UTC');
  });

  it('WhatsApp carries exactly one journal line, the last one', () => {
    const msg = buildWhatsApp({ ...base, journal: 'line one\nline two\nline three' });
    expect(msg).toContain('line three');
    expect(msg).not.toContain('line one');
  });

  it('the email carries all 30 lines', () => {
    const journal = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { text } = buildEmail({ ...base, journal });
    expect(text).toContain('line 1');
    expect(text).toContain('line 30');
  });

  it('never prints "exit 0" — the bug that made the alert unbelievable', () => {
    const msg = buildWhatsApp({ ...base, exitStatus: 1 });
    expect(msg).not.toContain('exit 0');
    expect(msg).toContain('קוד יציאה: 1 (ExecStartPre)');
  });

  it('an unknown exit code is a dash, not a zero', () => {
    expect(buildWhatsApp({ ...base, exitStatus: null, failingStep: null })).toContain('קוד יציאה: —');
  });

  it('a drill is labelled a drill, in both channels and in the subject', () => {
    const drill = { ...base, testMode: true };
    expect(buildWhatsApp(drill).split('\n')[0]).toMatch(/^\[בדיקה\]/);
    expect(buildWhatsApp(drill)).toContain('לא תקלה אמיתית');
    const { subject, text, html } = buildEmail(drill);
    expect(subject).toMatch(/^\[בדיקה\]/);
    expect(text).toContain('לא תקלה אמיתית');
    expect(html).toContain('לא תקלה אמיתית');
  });

  it('a real alert is never labelled a drill', () => {
    expect(buildWhatsApp(base)).not.toContain('בדיקה');
    expect(buildEmail(base).subject).not.toContain('בדיקה');
  });

  it('escapes journal text so a log line cannot break out into markup', () => {
    const { html } = buildEmail({ ...base, journal: '<script>alert(1)</script> & "q"' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(html).not.toContain('<script>a');
  });

  it('is RTL', () => {
    expect(buildEmail(base).html).toContain('dir="rtl"');
  });
});

describe('snapshotIsoFromJournal', () => {
  it('lifts the snapshot time out of the gate refusal', () => {
    expect(snapshotIsoFromJournal(GATE_JOURNAL)).toBe('2026-09-16T17:22:36+00:00');
  });
  it('returns null when the line is not there', () => {
    expect(snapshotIsoFromJournal('nothing here')).toBeNull();
  });
});

describe('parseExecStatus — the exit code comes from the step that actually failed', () => {
  // Real `systemctl show` output. ExecMainStatus is 0 here: no main process ran.
  const gateRefused = [
    'ExecStartPre={ path=/var/www/billing/scripts/backup/assert-storage-snapshot.sh ; argv[]=/var/www/billing/scripts/backup/assert-storage-snapshot.sh ; ignore_errors=no ; start_time=[Wed 2026-09-16 18:22:50 UTC] ; stop_time=[Wed 2026-09-16 18:22:53 UTC] ; pid=3871556 ; code=exited ; status=1 }',
    'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node cli.mjs storage-cleanup.ts ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  ].join('\n');

  it('reports the ExecStartPre refusal, not the main process that never ran', () => {
    expect(parseExecStatus(gateRefused)).toEqual({ step: 'ExecStartPre', status: 1 });
  });

  it('never reads status=0/0 on a step that never ran as a real exit 0', () => {
    const neverRan = 'ExecStart={ path=/bin/true ; start_time=[n/a] ; code=(null) ; status=0/0 }';
    expect(parseExecStatus(neverRan)).toEqual({ step: null, status: null });
  });

  it('finds the failure when ONE step has several commands on several lines', () => {
    // systemctl prints one line per command, all sharing the key. Keeping only
    // the last one hid the failure and reported the wrong step.
    const twoCommands = [
      'ExecStart={ path=/var/www/billing/scripts/backup/pg-backup.sh ; start_time=[Wed 2026-09-16 18:23:00 UTC] ; code=exited ; status=1 }',
      'ExecStart={ path=/var/www/billing/scripts/backup/restic-push.sh ; start_time=[n/a] ; code=(null) ; status=0/0 }',
    ].join('\n');
    expect(parseExecStatus(twoCommands)).toEqual({ step: 'ExecStart', status: 1 });
  });

  it('a later step beats an earlier one', () => {
    const both = [
      'ExecStartPre={ path=/a ; start_time=[Wed 2026-09-16 18:00:00 UTC] ; code=exited ; status=3 }',
      'ExecStart={ path=/b ; start_time=[Wed 2026-09-16 18:00:01 UTC] ; code=exited ; status=7 }',
    ].join('\n');
    expect(parseExecStatus(both)).toEqual({ step: 'ExecStart', status: 7 });
  });

  it('ignores properties that are not Exec steps', () => {
    expect(parseExecStatus('Result=exit-code\nExecMainStatus=0')).toEqual({ step: null, status: null });
  });
});

describe('latestFinishedIso — the NEWEST successful run, whatever order journalctl prints', () => {
  const lines = (order: 'asc' | 'desc') => {
    const l = [
      '2026-09-14T03:00:59+00:00 host systemd[1]: Finished billing-backup.service - x.',
      '2026-09-15T03:05:29+00:00 host systemd[1]: Finished billing-backup.service - x.',
      '2026-09-16T17:22:44+00:00 host systemd[1]: Finished billing-backup.service - x.',
    ];
    return (order === 'asc' ? l : [...l].reverse()).join('\n');
  };

  it('is the same answer whether the output is oldest-first or newest-first', () => {
    // journalctl -g prints newest-first on this host; reading it as oldest-first
    // once reported a backup as nine days stale when it had run that afternoon.
    expect(latestFinishedIso(lines('asc'))).toBe('2026-09-16T17:22:44.000Z');
    expect(latestFinishedIso(lines('desc'))).toBe('2026-09-16T17:22:44.000Z');
  });

  it('ignores lines that are not a completion', () => {
    expect(latestFinishedIso('2026-09-16T18:00:00+00:00 host systemd[1]: Failed to start billing-backup.service.')).toBeNull();
  });

  it('returns null when there is no history at all', () => {
    expect(latestFinishedIso('')).toBeNull();
  });
});
