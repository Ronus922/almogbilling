import { describe, it, expect } from 'vitest';
import { reminderInPast } from '@/lib/validation/tasks';
import type { ReminderChannel } from '@/lib/types/tasks';

const CH: ReminderChannel[] = ['in_app'];
const r = (iso: string) => ({ remind_at: iso, channels: CH, notify_owner: false });
const future = new Date(Date.now() + 3_600_000).toISOString();
const past = new Date(Date.now() - 3_600_000).toISOString();

describe('reminderInPast (server past-block)', () => {
  it('rejects a NEW past reminder', () => {
    expect(reminderInPast([r(past)], new Set())).toBe(true);
  });

  it('allows a future reminder', () => {
    expect(reminderInPast([r(future)], new Set())).toBe(false);
  });

  it('exempts an already-persisted past reminder (edit of an old record)', () => {
    const existing = new Set([Date.parse(past)]);
    expect(reminderInPast([r(past)], existing)).toBe(false);
  });

  it('still rejects a NEW past reminder even when other old ones are exempt', () => {
    const otherPast = new Date(Date.now() - 7_200_000).toISOString();
    expect(reminderInPast([r(otherPast), r(past)], new Set([Date.parse(otherPast)]))).toBe(true);
  });
});
