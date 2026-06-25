import {
  type ModuleScope,
  WHATSAPP_MODULE,
  INTERNAL_CHAT_MODULE,
  DEDICATED_MODULES,
} from '@/lib/db/notifications';

/**
 * Map the optional `?surface=` query param to a ModuleScope for the bulk
 * mark-all / clear-all routes, so the three header surfaces stay disjoint:
 *   - `surface=bell`          → every active row EXCEPT the dedicated modules
 *   - `surface=whatsapp`      → WhatsApp only (the WhatsApp chat dropdown)
 *   - `surface=internal_chat` → internal chat only (the internal-chat dropdown)
 *   - absent                  → everything (the full /notifications page)
 * Keeping this in one place guarantees read-all and clear-all agree.
 */
export function surfaceScope(req: Request): ModuleScope {
  const surface = new URL(req.url).searchParams.get('surface');
  if (surface === 'whatsapp') return { module: WHATSAPP_MODULE };
  if (surface === 'internal_chat') return { module: INTERNAL_CHAT_MODULE };
  if (surface === 'bell') return { excludeModules: DEDICATED_MODULES };
  return {};
}
