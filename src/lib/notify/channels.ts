import type { ReminderChannel } from '@/lib/types/tasks';

// Shared channel logic for the multi-select reminder model (migration 049).
// Used by BOTH validators (tasks + calendar) and the reminders engine, so the
// rules live in exactly one place.

export const REMINDER_CHANNELS: readonly ReminderChannel[] = ['in_app', 'email', 'whatsapp'];

export type CoerceChannelsResult =
  | { ok: true; channels: ReminderChannel[] }
  | { ok: false; error: string };

/**
 * Validate a body's `channels` into a deduped, NON-EMPTY subset of the real
 * channels. Accepts an array of channel strings; rejects a missing/empty set
 * (a reminder must fire on at least one channel).
 */
export function coerceChannels(raw: unknown): CoerceChannelsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_reminder_channels' };
  const seen = new Set<ReminderChannel>();
  for (const v of raw) {
    if (typeof v !== 'string' || !REMINDER_CHANNELS.includes(v as ReminderChannel)) {
      return { ok: false, error: 'invalid_reminder_channel' };
    }
    seen.add(v as ReminderChannel);
  }
  if (seen.size === 0) return { ok: false, error: 'no_reminder_channel' };
  return { ok: true, channels: [...seen] };
}

/**
 * Map a row's stored channels to the effective set the engine fires on. New rows
 * carry `channels` (049); legacy rows have only the single `channel` (which may
 * still be 'both' → {in_app,email}). Always returns a non-empty array.
 */
export function effectiveChannels(
  channels: ReminderChannel[] | null | undefined,
  legacyChannel: string | null | undefined,
): ReminderChannel[] {
  if (channels && channels.length > 0) return channels;
  if (legacyChannel === 'both') return ['in_app', 'email'];
  if (legacyChannel === 'in_app' || legacyChannel === 'email' || legacyChannel === 'whatsapp') {
    return [legacyChannel];
  }
  return ['in_app']; // unknown / null → safe default so a reminder never silently drops
}
