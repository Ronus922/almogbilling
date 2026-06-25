import type { ModuleScope } from '@/lib/db/notifications';

/**
 * Map the optional `?surface=` query param to a ModuleScope for the bulk
 * mark-all / clear-all routes, so the two header surfaces stay disjoint:
 *   - `surface=bell`     → every active row EXCEPT WhatsApp (the bell)
 *   - `surface=whatsapp` → WhatsApp only (the dedicated chat dropdown)
 *   - absent             → everything (the full /notifications page)
 * Keeping this in one place guarantees read-all and clear-all agree.
 */
export function surfaceScope(req: Request, whatsappModule: string): ModuleScope {
  const surface = new URL(req.url).searchParams.get('surface');
  if (surface === 'whatsapp') return { module: whatsappModule };
  if (surface === 'bell') return { excludeModule: whatsappModule };
  return {};
}
