import { describe, it, expect } from 'vitest';
import {
  coerceAndValidateParkingSpot,
  coerceAndValidateStorageUnit,
  coerceAndValidateToggleActive,
  parkingErrorMessage,
  PARKING_ERROR_MESSAGE,
  type ParkingErrorCode,
} from '@/lib/validation/parking';
import { SPOT_NUMBER_MAX } from '@/lib/constants/parking';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, DEFAULT_WORKER, MODULES } from '@/lib/permissions/constants';

// The apartment-link rule is the one the DB also enforces (migration 076's
// equality CHECK). These tests exist so a user meets it as a Hebrew field error
// and never as a 500 carrying a Postgres constraint name.
describe('parking validation — the apartment link', () => {
  const base = { spot_number: 42, size_type: 'single', sale_status: 'none' };

  it('owner_type=apartment REQUIRES an apartment number', () => {
    const r = coerceAndValidateParkingSpot({ ...base, owner_type: 'apartment' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('apartment_number_required');
  });

  it('owner_type=apartment accepts one', () => {
    const r = coerceAndValidateParkingSpot({ ...base, owner_type: 'apartment', apartment_number: '1234' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.fields.apartment_number).toBe('1234');
  });

  // The half that is easy to forget: switching owner_type away from 'apartment'
  // in a form leaves the old apartment number in state. Silently dropping it
  // would be worse than rejecting — the user thinks it saved as they see it.
  it('developer/committee REJECT a stray apartment number', () => {
    for (const owner of ['developer', 'committee'] as const) {
      const r = coerceAndValidateParkingSpot({ ...base, owner_type: owner, apartment_number: '1234' });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('apartment_number_not_allowed');
    }
  });

  it('developer/committee accept a blank apartment number as null', () => {
    for (const owner of ['developer', 'committee'] as const) {
      const r = coerceAndValidateParkingSpot({ ...base, owner_type: owner, apartment_number: '   ' });
      expect(r.ok).toBe(true);
      expect(r.ok && r.fields.apartment_number).toBeNull();
    }
  });

  it('applies the identical rule to storage units', () => {
    expect(coerceAndValidateStorageUnit({ unit_number: 'M-1', owner_type: 'apartment' }).ok).toBe(false);
    expect(coerceAndValidateStorageUnit({ unit_number: 'M-1', owner_type: 'developer', apartment_number: '99' }).ok).toBe(false);
    expect(coerceAndValidateStorageUnit({ unit_number: 'M-1', owner_type: 'apartment', apartment_number: '99' }).ok).toBe(true);
  });
});

describe('parking validation — spot number coercion', () => {
  const apt = { owner_type: 'apartment', apartment_number: '1234' };

  it('accepts a numeric string (forms send text)', () => {
    const r = coerceAndValidateParkingSpot({ ...apt, spot_number: ' 63 ' });
    expect(r.ok && r.fields.spot_number).toBe(63);
  });

  it('rejects missing, non-integer and out-of-range numbers', () => {
    expect(coerceAndValidateParkingSpot({ ...apt }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: '' }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: 'abc' }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: 4.5 }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: 0 }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: SPOT_NUMBER_MAX + 1 }).ok).toBe(false);
  });

  it('defaults lot_code, size_type and sale_status', () => {
    const r = coerceAndValidateParkingSpot({ ...apt, spot_number: 1 });
    expect(r.ok && r.fields.lot_code).toBe('1P');
    expect(r.ok && r.fields.size_type).toBe('single');
    expect(r.ok && r.fields.sale_status).toBe('none');
  });

  // double_length carries zero rows in the 2015 seed (the source document's
  // "3" markings were lost in OCR) — it must still be selectable, or the data
  // could never be corrected once the real markings are recovered.
  it('accepts every size_type including double_length', () => {
    for (const size of ['single', 'double_width', 'double_length'] as const) {
      const r = coerceAndValidateParkingSpot({ ...apt, spot_number: 1, size_type: size });
      expect(r.ok && r.fields.size_type).toBe(size);
    }
  });

  it('rejects unknown enum values', () => {
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: 1, size_type: 'triple' }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ ...apt, spot_number: 1, sale_status: 'pending' }).ok).toBe(false);
    expect(coerceAndValidateParkingSpot({ spot_number: 1, owner_type: 'landlord' }).ok).toBe(false);
  });
});

describe('toggle-active — the reason is mandatory only on the way down', () => {
  it('deactivating without a reason is rejected', () => {
    const r = coerceAndValidateToggleActive({ is_active: false });
    expect(r.ok === false && r.code).toBe('reason_required');
    expect(coerceAndValidateToggleActive({ is_active: false, reason: '   ' }).ok).toBe(false);
  });

  it('deactivating with a reason is accepted', () => {
    const r = coerceAndValidateToggleActive({ is_active: false, reason: 'נמכרה לדייר אחר' });
    expect(r.ok && r.fields.reason).toBe('נמכרה לדייר אחר');
  });

  it('reactivating needs no reason and discards any sent', () => {
    const r = coerceAndValidateToggleActive({ is_active: true, reason: 'ignored' });
    expect(r.ok && r.fields.is_active).toBe(true);
    expect(r.ok && r.fields.reason).toBeNull();
  });

  it('rejects a missing or non-boolean is_active', () => {
    expect(coerceAndValidateToggleActive({}).ok).toBe(false);
    expect(coerceAndValidateToggleActive({ is_active: 'false' }).ok).toBe(false);
  });
});

describe('every error code has a Hebrew message', () => {
  it('no code falls through to an English or empty message', () => {
    for (const code of Object.keys(PARKING_ERROR_MESSAGE) as ParkingErrorCode[]) {
      const msg = parkingErrorMessage(code);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toMatch(/[֐-׿]/); // contains Hebrew
    }
  });
});

describe('parking RBAC wiring', () => {
  it("is one module covering parking AND storage, in the 'main' group", () => {
    const mod = MODULES.find((m) => m.key === 'parking');
    expect(mod).toBeDefined();
    expect(mod!.group).toBe('main');
    expect(MODULES.filter((m) => m.key === 'storage')).toHaveLength(0);
  });

  it('manager gets view+edit; viewer and field workers get nothing', () => {
    expect(hasPermission('manager', DEFAULT_MANAGER, 'parking', 'view')).toBe(true);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'parking', 'edit')).toBe(true);
    for (const [role, perms] of [['viewer', DEFAULT_VIEWER], ['cleaner', DEFAULT_WORKER]] as const) {
      expect(hasPermission(role, perms, 'parking', 'view')).toBe(false);
      expect(hasPermission(role, perms, 'parking', 'edit')).toBe(false);
    }
  });

  it('a matrix role with no parking row is denied (fail-closed)', () => {
    expect(hasPermission('manager', [], 'parking', 'view')).toBe(false);
  });
});
