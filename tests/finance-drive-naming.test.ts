import { describe, expect, it } from 'vitest';
import { driveFileName, driveFolderPath, escapeDriveQuery } from '@/lib/finance/drive-naming';

describe('finance drive naming', () => {
  it('builds the folder path root / year / month', () => {
    expect(driveFolderPath('2026-09-15')).toEqual(['ALMOG — קבלות', '2026', '09']);
    expect(driveFolderPath('2026-01')).toEqual(['ALMOG — קבלות', '2026', '01']);
  });

  it('names the file date — category — ₪amount — original name', () => {
    expect(driveFileName({ date: '2026-09-15', category: 'חשמל', amount: 1234.5, originalName: 'invoice.pdf' }))
      .toBe('2026-09-15 — חשמל — ₪1,234.5 — invoice.pdf');
    expect(driveFileName({ date: '2026-09-01', category: 'ניקיון', amount: 3000, originalName: 'קבלה.jpg' }))
      .toBe('2026-09-01 — ניקיון — ₪3,000 — קבלה.jpg');
  });

  it('strips slashes and control characters and caps the length', () => {
    const name = driveFileName({ date: '2026-09-15', category: 'א/ב', amount: 1, originalName: 'x\\y\u0000.pdf' });
    expect(name).not.toMatch(/[\/\\\u0000]/);
    const long = driveFileName({ date: '2026-09-15', category: 'x'.repeat(300), amount: 1, originalName: 'a.pdf' });
    expect(long.length).toBe(200);
  });

  it("escapes the Drive q grammar (single quotes and backslashes)", () => {
    expect(escapeDriveQuery("O'Brien")).toBe("O\\'Brien");
    expect(escapeDriveQuery('a\\b')).toBe('a\\\\b');
    expect(escapeDriveQuery('ALMOG — קבלות')).toBe('ALMOG — קבלות');
  });
});
