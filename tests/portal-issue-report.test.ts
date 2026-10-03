import { describe, expect, it } from 'vitest';
import {
  PORTAL_IMAGE_MAX_INPUT_BYTES, PORTAL_IMAGE_MAX_UPLOAD_BYTES, PORTAL_ISSUE_DESCRIPTION_MAX, PORTAL_URGENCIES,
  decideImagePrep, portalImageError, portalIssueTitle, urgencyToPriority, validatePortalIssueReport,
} from '@/lib/portal/issueReport';

// The owners-portal fault report's rules (src/lib/portal/issueReport.ts) — one
// pure module shared by the screen and POST /api/portal/issues, so these are
// the server's rules and the screen's at once.

const MB = 1024 * 1024;
const valid = { location: 'לובי', area: '', description: 'נורה שרופה מעל המדרגות', urgency: 'regular' };

describe('validatePortalIssueReport — the text fields', () => {
  it('accepts a minimal report; an empty area becomes null', () => {
    const r = validatePortalIssueReport(valid);
    expect(r).toEqual({ ok: true, value: { location: 'לובי', area: null, description: 'נורה שרופה מעל המדרגות', urgency: 'regular' } });
  });

  it('location: at least 2 characters AFTER trimming', () => {
    for (const location of ['', 'א', '  א  ', '   ']) {
      const r = validatePortalIssueReport({ ...valid, location });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.location).toBe('יש לציין היכן התקלה');
    }
    const ok = validatePortalIssueReport({ ...valid, location: '  אב  ' });
    expect(ok.ok && ok.value.location).toBe('אב');
  });

  it('description: 5 to 2000 characters after trimming — 2001 is refused', () => {
    const short = validatePortalIssueReport({ ...valid, description: ' abcd ' });
    expect(!short.ok && short.errors.description).toBe('יש לתאר את התקלה בכמה מילים');
    const max = validatePortalIssueReport({ ...valid, description: 'א'.repeat(PORTAL_ISSUE_DESCRIPTION_MAX) });
    expect(max.ok).toBe(true);
    const over = validatePortalIssueReport({ ...valid, description: 'א'.repeat(PORTAL_ISSUE_DESCRIPTION_MAX + 1) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.description).toContain('2000');
  });

  it('a multipart CRLF counts as one character, like the textarea did', () => {
    // 1000 lines of "a\n" = 2000 characters on the screen; on the wire every
    // \n arrives as \r\n (2999 characters) and must still pass.
    const onScreen = Array.from({ length: 1000 }, () => 'a').join('\n') + 'b';
    expect(onScreen.length).toBe(2000);
    const r = validatePortalIssueReport({ ...valid, description: onScreen.replace(/\n/g, '\r\n') });
    expect(r.ok).toBe(true);
  });

  it('urgency: only the three keys; anything else is refused', () => {
    for (const urgency of ['high', 'normal', '', undefined, 'URGENT']) {
      const r = validatePortalIssueReport({ ...valid, urgency });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.urgency).toBe('יש לבחור דחיפות');
    }
  });

  it('reports every failing field at once (the screen counts them for the banner)', () => {
    const r = validatePortalIssueReport({ location: '', description: '', urgency: 'regular' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['description', 'location']);
  });

  it('ignores every other key — the reporter, phone and apartment come from the session only', () => {
    const r = validatePortalIssueReport({
      ...valid,
      reporter_phone: '+972500000000', phone: '0500000000', apartment: '1', reporter_apartment: '1',
      reporter_name: 'מתחזה', source: 'staff', priority: 'urgent', title: 'x',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['area', 'description', 'location', 'urgency']);
  });

  it('a File (or nothing) in a text slot is an empty string, which then fails its rule', () => {
    const r = validatePortalIssueReport({ ...valid, location: new File(['x'], 'x.txt'), description: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['description', 'location']);
  });
});

describe('urgency → priority (decision 03/10/2026)', () => {
  it('רגילה → normal, בינונית → high, דחופה → urgent', () => {
    expect(urgencyToPriority('regular')).toBe('normal');
    expect(urgencyToPriority('medium')).toBe('high');
    expect(urgencyToPriority('urgent')).toBe('urgent');
    expect(PORTAL_URGENCIES.map((u) => u.label)).toEqual(['רגילה', 'בינונית', 'דחופה']);
  });

  it('is one-to-one — no two urgencies open with the same priority', () => {
    const priorities = PORTAL_URGENCIES.map((u) => u.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe('portalIssueTitle', () => {
  it('"תקלה בשטח משותף: <מיקום>"', () => {
    expect(portalIssueTitle('חדר מדרגות')).toBe('תקלה בשטח משותף: חדר מדרגות');
  });
});

describe('decideImagePrep — reject / compress / as is', () => {
  const photo = (size: number, type: string, width: number, height: number) => ({ size, type, width, height });

  it('over 8MB is refused outright — never shrunk', () => {
    expect(decideImagePrep(photo(PORTAL_IMAGE_MAX_INPUT_BYTES + 1, 'image/jpeg', 1000, 800))).toBe('reject');
    expect(decideImagePrep(photo(20 * MB, 'image/heic', 8000, 6000))).toBe('reject');
  });

  it('exactly 8MB is still compressed (the limit is "over 8MB")', () => {
    expect(decideImagePrep(photo(PORTAL_IMAGE_MAX_INPUT_BYTES, 'image/jpeg', 4000, 3000))).toBe('compress');
  });

  it('a small jpeg / png / webp under 2000px and 5MB is uploaded as is', () => {
    expect(decideImagePrep(photo(2 * MB, 'image/jpeg', 2000, 1500))).toBe('as_is');
    expect(decideImagePrep(photo(1 * MB, 'image/png', 800, 600))).toBe('as_is');
    expect(decideImagePrep(photo(PORTAL_IMAGE_MAX_UPLOAD_BYTES, 'image/webp', 1200, 2000))).toBe('as_is');
  });

  it('a long edge over 2000px is compressed, whatever the weight', () => {
    expect(decideImagePrep(photo(1 * MB, 'image/jpeg', 2001, 1000))).toBe('compress');
    expect(decideImagePrep(photo(3 * MB, 'image/jpeg', 3024, 4032))).toBe('compress');
  });

  it('over 5MB (up to 8MB) is compressed even when small in pixels', () => {
    expect(decideImagePrep(photo(PORTAL_IMAGE_MAX_UPLOAD_BYTES + 1, 'image/jpeg', 1500, 1000))).toBe('compress');
  });

  it('a type the server refuses (HEIC, gif, unknown) is converted to JPEG', () => {
    expect(decideImagePrep(photo(1 * MB, 'image/heic', 1000, 800))).toBe('compress');
    expect(decideImagePrep(photo(1 * MB, 'image/heif', 1000, 800))).toBe('compress');
    expect(decideImagePrep(photo(1 * MB, 'image/gif', 400, 300))).toBe('compress');
    expect(decideImagePrep(photo(1 * MB, '', 400, 300))).toBe('compress');
  });
});

describe('portalImageError — the server gate per photo (unchanged: jpeg/png/webp ≤ 5MB)', () => {
  it('accepts the three types up to and including 5MB', () => {
    expect(portalImageError({ type: 'image/jpeg', size: PORTAL_IMAGE_MAX_UPLOAD_BYTES })).toBeNull();
    expect(portalImageError({ type: 'image/png', size: 10 })).toBeNull();
    expect(portalImageError({ type: 'image/webp', size: 10 })).toBeNull();
  });

  it('refuses video, any non-image and HEIC (the screen converts it first)', () => {
    expect(portalImageError({ type: 'video/mp4', size: 10 })).toBe('invalid_file_type');
    expect(portalImageError({ type: 'video/quicktime', size: 10 })).toBe('invalid_file_type');
    expect(portalImageError({ type: 'application/pdf', size: 10 })).toBe('invalid_file_type');
    expect(portalImageError({ type: 'image/heic', size: 10 })).toBe('invalid_file_type');
    expect(portalImageError({ type: '', size: 10 })).toBe('invalid_file_type');
  });

  it('refuses an empty file and anything over 5MB', () => {
    expect(portalImageError({ type: 'image/jpeg', size: 0 })).toBe('empty_file');
    expect(portalImageError({ type: 'image/jpeg', size: PORTAL_IMAGE_MAX_UPLOAD_BYTES + 1 })).toBe('file_too_large');
  });
});
