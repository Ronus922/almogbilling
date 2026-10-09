import 'server-only';
import { getSmtpSettings } from '@/lib/db/appSettings';
import { logger } from '@/lib/logger';
import { createSmtpTransporterCache, smtpTransportBase, type SmtpHandle } from './smtp-core';

// The app's pooled SMTP transporter. The build/cache logic is shared with the
// delivery worker (smtp-core.ts); this module only binds it to the app's
// settings reader and logger, and keeps one instance per process on globalThis.

const g = globalThis as unknown as { _smtpGet?: () => Promise<SmtpHandle> };

export async function getTransporter(): Promise<SmtpHandle> {
  g._smtpGet ??= createSmtpTransporterCache(
    smtpTransportBase(),
    getSmtpSettings,
    (e) => logger.error('[smtp pool error]', e),
  );
  return g._smtpGet();
}
