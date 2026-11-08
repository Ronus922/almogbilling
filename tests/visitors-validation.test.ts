import { describe, it, expect } from 'vitest';
import {
  bodyKeys, changePasswordSchema, isRealDate, isRealPastDate, visitorCreateSchema, visitorListQuerySchema,
  visitorNotesSchema, visitorUpdateSchema,
} from '@/lib/validation/visitors';
import { GUARD_USERNAME_RX, isValidGuardUsername, normalizeUsername } from '@/lib/auth/usernamePolicy';
import { phoneNeedle } from '@/lib/visitors/model';

const valid = {
  document_type: 'id_card',
  document_number: '123456789',
  first_name: 'דוד',
  last_name: 'כהן',
};

describe('visitorCreateSchema', () => {
  it('takes the four required fields and turns the blanks into null', () => {
    const r = visitorCreateSchema.parse({ ...valid, date_of_birth: '', phone: '  ', notes: '' });
    expect(r).toMatchObject({ ...valid, date_of_birth: null, nationality: null, phone: null, room_number: null, chip_number: null, notes: null });
  });

  it('keeps phone / room / chip as FREE text (never reshaped)', () => {
    const r = visitorCreateSchema.parse({ ...valid, phone: '050-123 4567 (בבית)', room_number: 'A-12', chip_number: 'x 7' });
    expect(r.phone).toBe('050-123 4567 (בבית)');
    expect(r.room_number).toBe('A-12');
    expect(r.chip_number).toBe('x 7');
  });

  it.each([
    ['document type', { document_type: 'visa' }],
    ['missing number', { document_number: '   ' }],
    ['missing first name', { first_name: '' }],
    ['missing last name', { last_name: '' }],
    ['number too long', { document_number: '1'.repeat(41) }],
    ['notes too long', { notes: 'x'.repeat(2001) }],
    ['impossible date', { date_of_birth: '1990-02-31' }],
    ['future date', { date_of_birth: '2999-01-01' }],
    ['not a date', { date_of_birth: 'yesterday' }],
    ['before 1900', { date_of_birth: '1899-12-31' }],
  ])('rejects %s', (_name, patch) => {
    expect(visitorCreateSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('visitorUpdateSchema / visitorNotesSchema', () => {
  it('an admin may send any subset, and an absent key stays absent', () => {
    const r = visitorUpdateSchema.parse({ first_name: 'דני' });
    expect(Object.keys(r)).toEqual(['first_name']);
  });

  it('an emptied field is sent as null (clears the column)', () => {
    expect(visitorUpdateSchema.parse({ phone: '' })).toEqual({ phone: null });
  });

  it('refuses a key that is not a column (strict) — no mass assignment', () => {
    expect(visitorUpdateSchema.safeParse({ first_name: 'דני', image_object_key: 'x', scanned_by: 'y' }).success).toBe(false);
    expect(visitorUpdateSchema.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('the notes schema takes the notes and nothing else', () => {
    expect(visitorNotesSchema.parse({ notes: ' תקין ' })).toEqual({ notes: 'תקין' });
    expect(visitorNotesSchema.safeParse({ notes: 'a', phone: '1' }).success).toBe(false);
  });
});

describe('list query + helpers', () => {
  it('defaults', () => {
    expect(visitorListQuerySchema.parse({})).toEqual({ q: '', page: 1 });
  });
  it('page is a positive integer; dates are YYYY-MM-DD', () => {
    expect(visitorListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(visitorListQuerySchema.safeParse({ page: '2', from: '2026-11-01', to: '2026-11-08' }).success).toBe(true);
    expect(visitorListQuerySchema.safeParse({ from: '1.11.2026' }).success).toBe(false);
  });
  it('bodyKeys reads only a plain object', () => {
    expect(bodyKeys({ a: 1, b: 2 })).toEqual(['a', 'b']);
    expect(bodyKeys([1, 2])).toEqual([]);
    expect(bodyKeys(null)).toEqual([]);
    expect(bodyKeys('x')).toEqual([]);
  });
  it('a filter date must be a real calendar day — 2026-02-31 is a 400, not a Postgres error', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-02-31')).toBe(false);
    expect(visitorListQuerySchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
    expect(visitorListQuerySchema.safeParse({ to: '2026-13-01' }).success).toBe(false);
    expect(visitorListQuerySchema.safeParse({ from: '2999-01-01' }).success).toBe(true); // a future bound is a valid filter
  });
  it('a NUL character (Postgres cannot store it) is refused everywhere text is taken', () => {
    expect(visitorCreateSchema.safeParse({ ...valid, first_name: 'ד\u0000וד' }).success).toBe(false);
    expect(visitorCreateSchema.safeParse({ ...valid, document_number: '12\u00003' }).success).toBe(false);
    expect(visitorCreateSchema.safeParse({ ...valid, notes: 'a\u0000b' }).success).toBe(false);
    expect(visitorUpdateSchema.safeParse({ phone: '05\u00000' }).success).toBe(false);
    expect(visitorListQuerySchema.safeParse({ q: 'a\u0000b' }).success).toBe(false);
  });
  it('isRealPastDate', () => {
    expect(isRealPastDate('1990-05-17')).toBe(true);
    expect(isRealPastDate('2024-02-29')).toBe(true);
    expect(isRealPastDate('2023-02-29')).toBe(false);
    expect(isRealPastDate('2999-01-01')).toBe(false);
  });
  it('phoneNeedle needs at least 3 digits and drops the national prefix (0 / +972)', () => {
    expect(phoneNeedle('052-662')).toBe('52662');
    expect(phoneNeedle('+972 52 662')).toBe('52662');
    expect(phoneNeedle('972526628944')).toBe('526628944');
    expect(phoneNeedle('0526628944')).toBe('526628944');
    expect(phoneNeedle('05')).toBe('');
    expect(phoneNeedle('דוד')).toBe('');
  });
  it('the password-change body needs both fields', () => {
    expect(changePasswordSchema.safeParse({ current_password: 'a', new_password: 'b' }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ current_password: '', new_password: 'b' }).success).toBe(false);
  });
});

describe('guard username policy', () => {
  it.each(['guard1', 'gate.night', 'a_b-c', 'abc'])('accepts %s', (u) => {
    expect(isValidGuardUsername(u)).toBe(true);
  });
  it.each(['ab', 'a@b.com', 'שומר1', 'has space', 'x'.repeat(33), '', 'name!'])('rejects %j', (u) => {
    expect(isValidGuardUsername(u)).toBe(false);
  });
  it('is case-insensitive at the door (stored lower-case) and never contains "@"', () => {
    expect(normalizeUsername('  Guard1 ')).toBe('guard1');
    expect(isValidGuardUsername('GUARD1')).toBe(true);
    expect(GUARD_USERNAME_RX.test('a@b')).toBe(false);
  });
});
