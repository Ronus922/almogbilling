import { describe, it, expect } from 'vitest';
import {
  coerceAndValidateParkingSpot,
  coerceAndValidateStorageUnit,
  coerceAndValidateToggleActive,
  parkingErrorMessage,
  PARKING_ERROR_MESSAGE,
  type ParkingErrorCode,
} from '@/lib/validation/parking';
import {
  PARKING_CATEGORY_ORDER,
  PARKING_EXPECTED,
  PARKING_EXPECTED_TOTAL,
  UNSOLD_DEVELOPER_APARTMENTS,
  SPOT_NUMBER_MAX,
} from '@/lib/constants/parking';
import { mapImportRow } from '@/lib/parking/importMapping';
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

// These figures are transcribed from "הצמדת חניות לדירות" (14.5.2015). The test
// pins the transcription itself: if someone "fixes" a number to make the summary
// screen go green, this fails — which is the entire point of the screen.
describe('the 2015 document figures are frozen', () => {
  it('has all six categories in document order', () => {
    expect(PARKING_CATEGORY_ORDER).toHaveLength(6);
    expect(Object.keys(PARKING_EXPECTED).sort()).toEqual([...PARKING_CATEGORY_ORDER].sort());
  });

  it('the six rows sum to the document total', () => {
    const sum = PARKING_CATEGORY_ORDER.reduce(
      (acc, k) => ({
        spots: acc.spots + PARKING_EXPECTED[k].spots,
        doubles: acc.doubles + PARKING_EXPECTED[k].doubles,
        places: acc.places + PARKING_EXPECTED[k].places,
      }),
      { spots: 0, doubles: 0, places: 0 },
    );
    expect(sum).toEqual(PARKING_EXPECTED_TOTAL);
  });

  it('places = spots + doubles in every row (a double is one spot, two places)', () => {
    for (const k of PARKING_CATEGORY_ORDER) {
      const f = PARKING_EXPECTED[k];
      expect(f.places).toBe(f.spots + f.doubles);
    }
    expect(PARKING_EXPECTED_TOTAL.places).toBe(
      PARKING_EXPECTED_TOTAL.spots + PARKING_EXPECTED_TOTAL.doubles,
    );
  });

  it('lists exactly the seven unsold apartments', () => {
    expect([...UNSOLD_DEVELOPER_APARTMENTS].sort()).toEqual(
      ['1341', '1407', '1440', '1539', '1619', '1620', '1628'],
    );
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

// ── Excel import mapping ─────────────────────────────────────────────────────
// The source worksheet overloads BOTH data columns: the notes column holds
// either a digit that encodes a property or free text, and the apartment column
// holds either a number or an owner keyword. These tests pin that decoding,
// because getting it wrong silently produces plausible-but-wrong ownership.

describe('Excel import mapping', () => {
  const row = (spot: unknown, apt: unknown, note: unknown) => mapImportRow(spot, apt, note, 7);

  it('decodes the notes digits as structure, not as notes', () => {
    const two = row(63, '1234', '2');
    expect(two.ok && two.row.size_type).toBe('double_width');
    expect(two.ok && two.row.notes).toBeNull();      // consumed, not kept

    const three = row(63, '1234', '3');
    expect(three.ok && three.row.size_type).toBe('double_length');

    const one = row(63, '1234', '1');
    expect(one.ok && one.row.sale_status).toBe('in_process');
    expect(one.ok && one.row.size_type).toBe('single');
  });

  it('keeps any other note as free text', () => {
    const r = row(63, '1234', 'ליד העמוד');
    expect(r.ok && r.row.notes).toBe('ליד העמוד');
    expect(r.ok && r.row.size_type).toBe('single');
    expect(r.ok && r.row.sale_status).toBe('none');
  });

  // The three quote characters are the difference between 36 developer spots
  // and 36 errors, depending on who typed the file.
  it('recognises חו״כ with any quote character', () => {
    for (const token of ['חו"כ', 'חו״כ', 'חו”כ', ' חו"כ ']) {
      const r = row(11, token, '');
      expect(r.ok && r.row.owner_type).toBe('developer');
      expect(r.ok && r.row.apartment_number).toBeNull();
    }
  });

  it('maps נציגות to committee AND for_sale', () => {
    const r = row(61, 'נציגות', '');
    expect(r.ok && r.row.owner_type).toBe('committee');
    expect(r.ok && r.row.sale_status).toBe('for_sale');
    expect(r.ok && r.row.apartment_number).toBeNull();
  });

  it('treats anything else in the apartment column as an apartment number', () => {
    const r = row(1, '534', '');
    expect(r.ok && r.row.owner_type).toBe('apartment');
    expect(r.ok && r.row.apartment_number).toBe('534');
  });

  it('a committee spot that is also double keeps BOTH facts', () => {
    const r = row(61, 'נציגות', '2');
    expect(r.ok && r.row.owner_type).toBe('committee');
    expect(r.ok && r.row.sale_status).toBe('for_sale');
    expect(r.ok && r.row.size_type).toBe('double_width');
  });

  it('rejects a row with no spot number or no owner', () => {
    expect(row('', '534', '').ok).toBe(false);
    expect(row('abc', '534', '').ok).toBe(false);
    expect(row(63, '', '').ok).toBe(false);
  });

  it('reports the worksheet row number so the user can find the line', () => {
    const r = mapImportRow('', '534', '', 42);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.rowNumber).toBe(42);
    expect(r.ok === false && r.error.raw.apartment).toBe('534');
  });
});
