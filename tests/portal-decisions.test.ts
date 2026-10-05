import { describe, expect, it } from 'vitest';
import {
  DECISION_FILE, decisionTypeTag, decisionYear, formatDecisionDate, formatFileSize,
  isDecisionType, matchesDecisionQuery, validateDecisionFile,
} from '@/lib/decisions';

const MB = 1024 * 1024;

describe('decision file policy', () => {
  it('accepts a PDF and nothing else', () => {
    expect(validateDecisionFile({ name: 'החלטה.pdf', size: 10 * MB, type: 'application/pdf' })).toBeNull();
    expect(validateDecisionFile({ name: 'SCAN.PDF', size: 1000, type: '' })).toBeNull();
    expect(validateDecisionFile({ name: 'protocol.docx', size: 1000, type: '' })).toMatch(/PDF/);
    expect(validateDecisionFile({ name: 'scan.png', size: 1000, type: 'image/png' })).toMatch(/PDF/);
    expect(validateDecisionFile({ name: 'noext', size: 1000, type: 'application/pdf' })).toMatch(/PDF/);
    expect(DECISION_FILE.accept).toBe('.pdf,application/pdf');
  });

  it('the extension decides; a contradicting browser MIME is refused', () => {
    expect(validateDecisionFile({ name: 'x.pdf', size: 10, type: 'image/png' })).toMatch(/אינו PDF/);
    // Browsers are flaky about MIME — octet-stream and '' always pass.
    expect(validateDecisionFile({ name: 'x.pdf', size: 10, type: 'application/octet-stream' })).toBeNull();
  });

  it('enforces the 50MB ceiling and refuses an empty file', () => {
    expect(validateDecisionFile({ name: 'x.pdf', size: 0, type: '' })).toMatch(/ריק/);
    expect(validateDecisionFile({ name: 'x.pdf', size: DECISION_FILE.maxBytes, type: '' })).toBeNull();
    expect(validateDecisionFile({ name: 'x.pdf', size: DECISION_FILE.maxBytes + 1, type: '' })).toMatch(/50MB/);
  });

  it('knows the two document types and nothing else', () => {
    expect(isDecisionType('decision')).toBe(true);
    expect(isDecisionType('protocol')).toBe(true);
    expect(isDecisionType('minutes')).toBe(false);
    expect(isDecisionType(null)).toBe(false);
  });
});

describe('decision labels and formats', () => {
  it('a decision carries its number, a protocol never does', () => {
    expect(decisionTypeTag('decision', '14/2026')).toBe('החלטה 14/2026');
    expect(decisionTypeTag('decision', null)).toBe('החלטה');
    expect(decisionTypeTag('decision', '   ')).toBe('החלטה');
    // Even if a number somehow reached a protocol row, the tag ignores it.
    expect(decisionTypeTag('protocol', '14/2026')).toBe('פרוטוקול');
  });

  it('formats the date as the reference does, without parsing it as a moment', () => {
    expect(formatDecisionDate('2026-09-08')).toBe('08.09.2026');
    // A date column is a calendar day: no timezone may move it.
    expect(formatDecisionDate('2026-01-01')).toBe('01.01.2026');
    expect(decisionYear('2025-12-31')).toBe('2025');
  });

  it('formats the file size as the reference does', () => {
    expect(formatFileSize(412 * 1024)).toBe('412 KB');
    expect(formatFileSize(Math.round(1.1 * MB))).toBe('1.1 MB');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(900)).toBe('900 B');
  });
});

describe('the portal search', () => {
  const row = { title: 'אישור תקציב הבניין לשנת 2026', summary: 'האסיפה אישרה תקציב של ₪118,000.' };

  it('matches the title and the summary, ignores case and surrounding spaces', () => {
    expect(matchesDecisionQuery(row, 'תקציב')).toBe(true);
    expect(matchesDecisionQuery(row, '  118,000 ')).toBe(true);
    expect(matchesDecisionQuery(row, 'מעלית')).toBe(false);
    expect(matchesDecisionQuery({ title: 'Lobby', summary: null }, 'lobby')).toBe(true);
  });

  it('an empty query matches everything, including a row with no summary', () => {
    expect(matchesDecisionQuery(row, '')).toBe(true);
    expect(matchesDecisionQuery(row, '   ')).toBe(true);
    expect(matchesDecisionQuery({ title: 'פרוטוקול', summary: null }, '')).toBe(true);
  });
});
