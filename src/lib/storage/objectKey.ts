import 'server-only';
import { randomUUID } from 'node:crypto';

/**
 * Builds an ASCII-safe Supabase Storage object key.
 *
 * Self-hosted Supabase Storage rejects any non-ASCII key (e.g. a Hebrew file
 * name) with "Invalid key", so the original name is NEVER placed in the key —
 * it is only the source of the file extension. The display name is persisted
 * separately by each caller (DB column / API param), independent of the key.
 *
 * Shape: `${prefix}/${uuid}${ext}` when a prefix is given, otherwise a flat
 * `${uuid}${ext}`. The extension is kept only when it is a short alphanumeric
 * token, normalised to lower-case; anything else yields no extension.
 */
export function buildObjectKey(originalName: string, prefix?: string): string {
  const lastDot = originalName.lastIndexOf('.');
  const rawExt = lastDot > 0 ? originalName.slice(lastDot + 1) : '';
  const ext = /^[a-zA-Z0-9]{1,10}$/.test(rawExt) ? `.${rawExt.toLowerCase()}` : '';
  const name = `${randomUUID()}${ext}`;
  return prefix ? `${prefix}/${name}` : name;
}
