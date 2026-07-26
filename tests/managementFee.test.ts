import { describe, it, expect } from 'vitest';
import {
  computeManagementFee,
  MANAGEMENT_FEE_MULTIPLIER,
} from '@/lib/billing/managementFee';

// The management fee shown on the apartment card is DERIVED, never typed:
//   size (m²) × 150% × the per-m² rate from Settings.
// The same helper feeds the card preview, POST/PATCH /api/contacts and the
// bulk recompute triggered when the rate changes — so this formula is the one
// place where the number is defined.

describe('computeManagementFee', () => {
  it('multiplies size by 150% and the rate', () => {
    expect(MANAGEMENT_FEE_MULTIPLIER).toBe(1.5);
    expect(computeManagementFee(85, 12)).toBe(1530); // 85 × 1.5 × 12
    expect(computeManagementFee(100, 10)).toBe(1500);
  });

  it('rounds to agorot', () => {
    expect(computeManagementFee(33.33, 7.77)).toBe(388.46); // 388.4624… → 388.46
  });

  it('returns null when an input is missing — the field is then left alone', () => {
    expect(computeManagementFee(null, 12)).toBeNull();
    expect(computeManagementFee(85, null)).toBeNull();
    expect(computeManagementFee(undefined, undefined)).toBeNull();
  });

  it('rejects negative and non-finite inputs', () => {
    expect(computeManagementFee(-5, 12)).toBeNull();
    expect(computeManagementFee(85, -1)).toBeNull();
    expect(computeManagementFee(Number.NaN, 12)).toBeNull();
    expect(computeManagementFee(85, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('treats a zero size or zero rate as a real zero fee', () => {
    expect(computeManagementFee(0, 12)).toBe(0);
    expect(computeManagementFee(85, 0)).toBe(0);
  });
});
