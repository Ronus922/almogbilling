import 'server-only';
import { createNotification } from '@/services/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import type { Issue } from '@/lib/types/issues';
import { logger } from '@/lib/logger';

/**
 * "תקלה חדשה נפתחה" — the in-app bell to every active admin (super_admin +
 * admin) when an issue is opened, from either door:
 *   • the issues screen (POST /api/issues) — the reporter is a staff user and
 *     is skipped, exactly as before this was shared;
 *   • the owners portal (POST /api/portal/issues) — the reporter has no users
 *     row (`reporterUserId` null), so every admin gets it.
 * Bell only: e-mail / WhatsApp stay with the creator's notify matrix on the
 * staff route, and the portal has none. Best-effort, deduped per (issue,
 * admin); never throws (it runs after the issue is already persisted).
 */
export async function notifyAdminsOfIssueReported(
  issue: Pick<Issue, 'id' | 'title' | 'description'>,
  reporterUserId: string | null,
): Promise<void> {
  try {
    const desc = issue.description?.trim();
    const message = desc ? `${issue.title} — ${desc.slice(0, 120)}` : issue.title;
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      if (admin.id === reporterUserId) continue;
      await createNotification({
        userId: admin.id,
        type: 'issue_reported',
        title: 'תקלה חדשה נפתחה',
        message,
        sourceModule: 'issues',
        sourceEntityType: 'issue',
        sourceEntityId: issue.id,
        actionUrl: `/issues?issue=${issue.id}`,
        priority: 'high',
        dedupeKey: `issue_reported:${issue.id}:${admin.id}`,
      });
    }
  } catch (err) {
    logger.error('[issues] issue_reported notification failed', err);
  }
}
