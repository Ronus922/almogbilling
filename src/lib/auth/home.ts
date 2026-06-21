import type { Role } from '@/lib/permissions/constants';

/**
 * Post-login / landing path per role. A viewer holds only `dashboard:view`
 * (the debtors screen at /dashboard), so they land there. Every other role
 * lands on the new overview at /overview. Centralised here so the root page,
 * the login/invite forms, and the /overview guard all agree.
 */
export function homePathFor(role: Role): string {
  return role === 'viewer' ? '/dashboard' : '/overview';
}
