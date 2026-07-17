// Pure shared types + coercion for the create-form notification matrix
// (recipient × channel). NO server-only / DB imports — safe on client + routes.
//
// Multi-assignee (047): the matrix has one row per recipient — "me" plus one row
// per selected assignee (user OR supplier). Selection is keyed by a recipient
// key so an arbitrary number of assignee rows is supported:
//   'me' | `user:<uuid>` | `supplier:<uuid>`
// Default = no keys selected → nothing sent. In-app (bell) is separate and not
// governed here.

export interface NotifyChannelSelection {
  email: boolean;
  whatsapp: boolean;
}

/** recipientKey → channel selection. Only selected recipients appear. */
export type NotifySelection = Record<string, NotifyChannelSelection>;

export const EMPTY_NOTIFY_SELECTION: NotifySelection = {};

/** A user the matrix can target ("me"/assignee), with contact-detail availability. */
export interface NotifyUserContact {
  id: string;
  name: string;
  hasEmail: boolean;
  hasPhone: boolean;
}

export type RecipientKind = 'me' | 'user' | 'supplier';

export function recipientKey(kind: RecipientKind, id?: string): string {
  return kind === 'me' ? 'me' : `${kind}:${id}`;
}

export function parseRecipientKey(
  key: string,
): { kind: 'me' } | { kind: 'user' | 'supplier'; id: string } | null {
  if (key === 'me') return { kind: 'me' };
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const k = key.slice(0, idx);
  const id = key.slice(idx + 1);
  if ((k === 'user' || k === 'supplier') && id) return { kind: k, id };
  return null;
}

function coerceChannel(v: unknown): NotifyChannelSelection {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { email: o.email === true, whatsapp: o.whatsapp === true };
}

/** Coerce arbitrary JSON `notify` into a NotifySelection, keeping only the
 *  recipients that have at least one channel selected. */
export function coerceNotifySelection(raw: unknown): NotifySelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: NotifySelection = {};
  let kept = 0;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length > 80) continue;
    if (parseRecipientKey(key) === null) continue;
    const c = coerceChannel(v);
    if (c.email || c.whatsapp) {
      out[key] = c;
      if (++kept >= 200) break; // sanity cap
    }
  }
  return out;
}

export function channelFor(sel: NotifySelection, key: string): NotifyChannelSelection {
  return sel[key] ?? { email: false, whatsapp: false };
}

/** Global channel choice (no per-recipient matrix) — the create-form's two
 *  channel cards. Applied uniformly to every selected handler at submit. */
export type ChannelValue = NotifyChannelSelection;
export const EMPTY_CHANNELS: ChannelValue = { email: false, whatsapp: false };

/**
 * Expand a global channel choice over the given recipient keys into the
 * recipient-keyed NotifySelection the routes already consume. No channel
 * selected → {} (nothing sent). No recipient keys → {} (no handler → nothing).
 * The server still governs edit-mode fan-out (filterAddedAssignees), so callers
 * may safely pass ALL current assignee keys.
 */
export function channelsToSelection(channels: ChannelValue, recipientKeys: string[]): NotifySelection {
  if (!channels.email && !channels.whatsapp) return {};
  const out: NotifySelection = {};
  for (const k of recipientKeys) out[k] = { email: channels.email, whatsapp: channels.whatsapp };
  return out;
}

export function hasAnyNotify(sel: NotifySelection): boolean {
  return Object.keys(sel).length > 0;
}
