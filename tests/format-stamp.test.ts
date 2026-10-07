import { describe, expect, it } from 'vitest';
import { formatStamp } from '@/lib/dashboard/formatStamp';

// formatStamp — DD.MM.YYYY HH:mm (or DD/MM/YYYY with '/') on the Asia/Jerusalem
// clock. The issue card footer passes `created_at::text` straight from
// Postgres, which is not an ECMAScript date string, so it is parsed via ISO.

describe('formatStamp', () => {
  it('keeps the dotted default for an ISO string and a Date', () => {
    expect(formatStamp('2026-10-04T19:13:24.220Z')).toBe('04.10.2026 22:13');
    expect(formatStamp(new Date('2026-10-04T19:13:24.220Z'))).toBe('04.10.2026 22:13');
  });

  it("formats DD/MM/YYYY HH:mm with '/'", () => {
    expect(formatStamp('2026-10-04T19:13:24.220Z', '/')).toBe('04/10/2026 22:13');
  });

  it('reads a Postgres timestamptz::text value (microseconds, +00)', () => {
    expect(formatStamp('2026-10-04 19:13:24.220808+00', '/')).toBe('04/10/2026 22:13');
    expect(formatStamp('2026-10-04 19:13:24+00', '/')).toBe('04/10/2026 22:13');
    expect(formatStamp('2026-10-04 19:13:24.5+03:00', '/')).toBe('04/10/2026 19:13');
  });

  it('follows Israel summer and winter time and the day rollover', () => {
    expect(formatStamp('2026-07-27 07:53:54.835411+00', '/')).toBe('27/07/2026 10:53');
    expect(formatStamp('2026-12-31 22:30:00+00', '/')).toBe('01/01/2027 00:30');
  });

  it('returns an empty string for nothing or garbage', () => {
    expect(formatStamp(null)).toBe('');
    expect(formatStamp(undefined, '/')).toBe('');
    expect(formatStamp('not a date', '/')).toBe('');
  });
});
