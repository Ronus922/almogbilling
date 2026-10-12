import { isWorkerRole, type Role } from '@/lib/permissions/constants';

/**
 * Post-login / landing path per role. Centralised here so the root page, the
 * login/invite forms, and the /overview guard all agree.
 *
 *  - viewer holds only `dashboard:view` (the debtors screen) → /dashboard.
 *  - cleaner / maintenance hold only tasks + issues, their whole job →
 *    /issues (the pre-11/10/2026 default, restored 12/10/2026 now that /work
 *    is gone and תקלות/משימות are two screens again). Landing them on
 *    /overview would bounce them straight back out (they have no permission
 *    for it), so the landing path has to know about them.
 *  - everyone else → the overview.
 */
export function homePathFor(role: Role): string {
  if (role === 'viewer') return '/dashboard';
  if (isWorkerRole(role)) return '/issues';
  return '/overview';
}
