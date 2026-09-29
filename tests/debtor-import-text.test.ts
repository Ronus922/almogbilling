import { describe, expect, it } from 'vitest';
import { visibleImportText } from '@/lib/debtor-import-text';

// The display guard of 29/09/2026: "פרטים" / "חודשי פיגור" describe the debt, so
// they are not shown next to a ₪0 balance — the last line behind the import's
// own clearing (lib/import/clearing.ts). Pure; no DB, no rendering.
describe('visibleImportText', () => {
  it('shows the text while there is a debt', () => {
    expect(visibleImportText('מים חמים 05-06/25', 1240)).toBe('מים חמים 05-06/25');
    expect(visibleImportText('1/26 - 9/26', 0.01)).toBe('1/26 - 9/26');
  });

  it('hides a leftover once the debt is settled', () => {
    expect(visibleImportText('מים חמים 05-06/25', 0)).toBeNull();
    expect(visibleImportText('מים חמים 05-06/25', null)).toBeNull();
    expect(visibleImportText('מים חמים 05-06/25', undefined)).toBeNull();
  });

  it('treats a negative balance (overpaid) as settled', () => {
    expect(visibleImportText('מים חמים 05-06/25', -50)).toBeNull();
  });

  it('normalises empty and whitespace-only text to null at any balance', () => {
    for (const debt of [1240, 0]) {
      expect(visibleImportText(null, debt)).toBeNull();
      expect(visibleImportText(undefined, debt)).toBeNull();
      expect(visibleImportText('', debt)).toBeNull();
      expect(visibleImportText('   \n ', debt)).toBeNull();
    }
  });

  it('returns the text unchanged — never trimmed, so pre-wrap layout is preserved', () => {
    expect(visibleImportText('  שורה\n  שורה שנייה  ', 100)).toBe('  שורה\n  שורה שנייה  ');
  });
});
