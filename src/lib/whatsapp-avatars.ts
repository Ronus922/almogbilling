import 'server-only';
import { getGreenApiSettings, GreenApiNotConfiguredError } from '@/lib/db/greenApiSettings';
import { getAvatar } from '@/lib/whatsapp';
import { listStaleAvatarChats, upsertAvatar } from '@/lib/db/whatsappAvatars';

// Lazy, best-effort avatar refresh. Called fire-and-forget AFTER the
// conversations list is already returned, so it never delays the response.
// Per request it refreshes at most MAX_PER_REQUEST stale conversations with a
// short pause between Green API calls — the inbox's 5s polling completes the
// list gradually. A process-level in-flight guard prevents overlapping polls
// (multiple open inboxes) from stacking into a Green API call storm.

const MAX_PER_REQUEST = 5;
const DELAY_MS = 400;
const MAX_AGE_DAYS = 3;

let refreshing = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh up to a few stale conversation avatars from Green API and cache the
 * result — including the "no picture" case (cached as NULL so we don't re-probe
 * for MAX_AGE_DAYS). Never throws; avatars are decorative and must never break
 * the inbox. No-op when Green API isn't configured or a refresh is already running.
 */
export async function refreshStaleAvatars(chatIds: string[]): Promise<void> {
  if (refreshing || chatIds.length === 0) return;
  refreshing = true;
  try {
    const stale = await listStaleAvatarChats(chatIds, MAX_PER_REQUEST, MAX_AGE_DAYS);
    if (stale.length === 0) return;

    let instanceId: string;
    let token: string;
    try {
      ({ instanceId, token } = await getGreenApiSettings());
    } catch (err) {
      if (err instanceof GreenApiNotConfiguredError) return;
      throw err;
    }

    for (const chatId of stale) {
      const { urlAvatar } = await getAvatar({ instanceId, token, chatId });
      // urlAvatar is null when unavailable — cached as NULL with a fresh
      // fetched_at so we don't hammer Green API for the same empty contact.
      await upsertAvatar(chatId, urlAvatar);
      await sleep(DELAY_MS);
    }
  } catch (err) {
    console.error('[whatsapp/avatars] refresh failed', err);
  } finally {
    refreshing = false;
  }
}
