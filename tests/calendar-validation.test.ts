import { describe, it, expect } from 'vitest';
import { coerceEventInput, coerceRecurrence, coerceParticipants } from '@/lib/validation/calendar';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

describe('coerceEventInput — date validity', () => {
  it('accepts a real date', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-09-15' }, 'create');
    expect(r.ok).toBe(true);
  });

  it('rejects an impossible date (2026-02-30)', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-02-30' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_event_date');
  });

  it('rejects Feb 29 on a non-leap year', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2026-02-29' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('accepts Feb 29 on a leap year', () => {
    const r = coerceEventInput({ title: 'x', event_date: '2028-02-29' }, 'create');
    expect(r.ok).toBe(true);
  });

  it('rejects malformed date string', () => {
    const r = coerceEventInput({ title: 'x', event_date: '15/09/2026' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('rejects end before start', () => {
    const r = coerceEventInput(
      { title: 'x', event_date: '2026-09-15', start_datetime: '2026-09-15T10:00:00Z', end_datetime: '2026-09-15T09:00:00Z' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('end_before_start');
  });
});

describe('coerceRecurrence — until_date validity', () => {
  it('rejects an impossible until_date', () => {
    const r = coerceRecurrence({ recurrence: { type: 'weekly', interval: 1, endType: 'until_date', untilDate: '2026-13-01' } });
    expect(r.ok).toBe(false);
  });

  it('accepts a valid weekly rule with count', () => {
    const r = coerceRecurrence({ recurrence: { type: 'weekly', interval: 1, endType: 'count', count: 5 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule?.count).toBe(5);
  });

  it('null recurrence → no rule', () => {
    const r = coerceRecurrence({ recurrence: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule).toBeNull();
  });
});

describe('coerceParticipants — registered (user)', () => {
  it('accepts a user with a valid uuid', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'user', participant_id: UUID, display_name_cache: 'דנה' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.participants).toHaveLength(1);
      expect(r.participants[0].participant_source).toBe('user');
      expect(r.participants[0].participant_id).toBe(UUID);
    }
  });

  it('rejects a user without a valid uuid', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'user', participant_id: 'not-a-uuid' },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_participant_id');
  });

  it('dedupes the same user id', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'user', participant_id: UUID },
      { participant_source: 'user', participant_id: UUID },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participants).toHaveLength(1);
  });
});

describe('coerceParticipants — external (free text)', () => {
  it('forces participant_id to NULL even if the client tries to send one', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'external', participant_id: UUID2, display_name_cache: 'עו״ד כהן' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.participants[0].participant_source).toBe('external');
      expect(r.participants[0].participant_id).toBeNull();
      expect(r.participants[0].display_name_cache).toBe('עו״ד כהן');
    }
  });

  it('trims the name', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'external', display_name_cache: '  קבלן  ' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participants[0].display_name_cache).toBe('קבלן');
  });

  it('rejects an empty external name', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'external', display_name_cache: '   ' },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_external_name');
  });

  it('rejects an external name over 100 chars', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'external', display_name_cache: 'א'.repeat(101) },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('external_name_too_long');
  });

  it('dedupes external names case-insensitively', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'external', display_name_cache: 'Cohen' },
      { participant_source: 'external', display_name_cache: 'cohen' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participants).toHaveLength(1);
  });
});

describe('coerceParticipants — legacy contact (read-only round-trip)', () => {
  it('preserves a legacy contact with a valid id', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'contact', participant_id: UUID, display_name_cache: 'בעלים דירה 5' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.participants[0].participant_source).toBe('contact');
      expect(r.participants[0].participant_id).toBe(UUID);
    }
  });

  it('keeps a legacy contact name even without a valid id (never drops it)', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'contact', participant_id: null, display_name_cache: 'שוכר דירה 7' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.participants).toHaveLength(1);
      expect(r.participants[0].participant_id).toBeNull();
      expect(r.participants[0].display_name_cache).toBe('שוכר דירה 7');
    }
  });
});

describe('coerceParticipants — mixed + edge', () => {
  it('rejects an unknown source', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'robot', participant_id: UUID },
    ] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_participant_source');
  });

  it('combines a user and two externals', () => {
    const r = coerceParticipants({ participants: [
      { participant_source: 'user', participant_id: UUID, display_name_cache: 'דנה' },
      { participant_source: 'external', display_name_cache: 'עו״ד' },
      { participant_source: 'external', display_name_cache: 'קבלן' },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.participants).toHaveLength(3);
      expect(r.participants.filter((p) => p.participant_source === 'external')).toHaveLength(2);
    }
  });

  it('absent participants → empty list', () => {
    const r = coerceParticipants({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participants).toEqual([]);
  });
});
