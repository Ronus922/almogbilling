import { describe, expect, it } from 'vitest';
import { buildUnitFailureEmail, describeExit, type UnitFailure } from '../scripts/lib/unit-failure';

// The alert body is the whole product of scripts/alert-unit-failure.ts: a
// failure report that loses the unit name, the time or the journal tells the
// reader nothing. These pin the three, in both parts.
const failure: UnitFailure = {
  unit: 'billing-storage-cleanup.service',
  result: 'exit-code',
  exitStatus: 'exit 1',
  whenIso: '2026-09-16T18:30:00.000Z',
  journal: 'REFUSING: the newest snapshot is 40.2h old\nControl process exited, status=1/FAILURE',
};

describe('buildUnitFailureEmail', () => {
  it('names the failed unit in the subject', () => {
    expect(buildUnitFailureEmail(failure).subject).toContain('billing-storage-cleanup.service');
  });

  it('carries the unit, the UTC time and the journal in both parts', () => {
    const { text, html } = buildUnitFailureEmail(failure);
    for (const body of [text, html]) {
      expect(body).toContain('billing-storage-cleanup.service');
      expect(body).toContain('2026-09-16T18:30:00.000Z');
      expect(body).toContain('exit-code');
      expect(body).toContain('REFUSING: the newest snapshot is 40.2h old');
      expect(body).toContain('Control process exited, status=1/FAILURE');
    }
  });

  it('states the time as UTC, so nobody has to guess the offset', () => {
    const { text, html } = buildUnitFailureEmail(failure);
    expect(text).toMatch(/UTC/);
    expect(html).toMatch(/UTC/);
  });

  it('escapes journal text so a log line cannot break out into markup', () => {
    const { html } = buildUnitFailureEmail({
      ...failure,
      journal: '<script>alert(1)</script> & "quoted"',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<script>');
  });

  it('is RTL, matching the rest of the product', () => {
    expect(buildUnitFailureEmail(failure).html).toContain('dir="rtl"');
  });

  it('keeps an empty journal from producing a body that looks truncated', () => {
    const { text, html } = buildUnitFailureEmail({ ...failure, journal: '' });
    expect(text).toContain('billing-storage-cleanup.service');
    expect(html).toContain('journalctl -u billing-storage-cleanup.service');
  });
});

describe('describeExit — systemd exit state in words', () => {
  it('names an ExecStartPre refusal instead of reporting "exit 0" next to "failed"', () => {
    // ExecMainCode=0 means no main process ever ran — exactly what a refusing
    // gate looks like. "exit 0" there makes the reader doubt the alert.
    expect(describeExit('0', '0')).toMatch(/never ran/);
    expect(describeExit(undefined, undefined)).toMatch(/never ran/);
    expect(describeExit('0', '0')).not.toMatch(/exit 0/);
  });

  it('reports a real non-zero exit', () => {
    expect(describeExit('1', '1')).toBe('exit 1');
    expect(describeExit('1', '137')).toBe('exit 137');
  });

  it('reports a signal kill as a kill (CLD_KILLED = 2)', () => {
    expect(describeExit('2', '9')).toBe('killed by signal 9');
  });
});
