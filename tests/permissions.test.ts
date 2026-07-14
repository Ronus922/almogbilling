import { describe, it, expect } from 'vitest';
import { hasPermission, getDefaultPermissions, canManageRole } from '@/lib/permissions/check';
import {
  DEFAULT_VIEWER, DEFAULT_MANAGER, DEFAULT_WORKER,
  ROLE_VALUES, isMatrixRole, isElevatedRole, isWorkerRole,
} from '@/lib/permissions/constants';
import { homePathFor } from '@/lib/auth/home';

describe('hasPermission — RBAC matrix (the authorization model)', () => {
  it('super_admin can do everything', () => {
    expect(hasPermission('super_admin', [], 'import', 'edit')).toBe(true);
    expect(hasPermission('super_admin', [], 'users_management', 'edit')).toBe(true);
    expect(hasPermission('super_admin', [], 'settings', 'view')).toBe(true);
  });

  it('admin can do everything EXCEPT super-admin-only modules', () => {
    expect(hasPermission('admin', [], 'import', 'edit')).toBe(true);
    expect(hasPermission('admin', [], 'settings', 'edit')).toBe(true);
    expect(hasPermission('admin', [], 'dashboard', 'edit')).toBe(true);
    // super-admin-only
    expect(hasPermission('admin', [], 'users_management', 'view')).toBe(false);
    expect(hasPermission('admin', [], 'roles_management', 'edit')).toBe(false);
  });

  it('viewer (default matrix) cannot import and cannot edit', () => {
    // The exact privilege the original exploit abused:
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'import', 'edit')).toBe(false);
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'import', 'view')).toBe(false);
    // viewer can VIEW the dashboard but not edit it
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'dashboard', 'view')).toBe(true);
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'dashboard', 'edit')).toBe(false);
    // viewer has no status_management at all
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'status_management', 'view')).toBe(false);
    // viewer has no settings
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'settings', 'view')).toBe(false);
  });

  // Viewer is locked to the DEBTORS SCREEN (dashboard) ONLY — read-only, no other
  // module visible. The debtors detail-panel reads (debtor / comments / history /
  // status display) are granted at the route layer via requireAnyPermission()
  // against `dashboard`, NOT via a `contacts` / `status_management` grant here.
  it('viewer sees ONLY the dashboard (debtors screen) — every other module is off', () => {
    // dashboard = the one allowed module (view-only).
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'dashboard', 'view')).toBe(true);
    // Everything else: no view, no edit.
    for (const m of [
      'analytics', 'contacts', 'suppliers', 'whatsapp', 'tasks', 'issues',
      'calendar', 'documents', 'whatsapp_chat', 'internal_chat', 'user_reminders',
      'import', 'export', 'status_management', 'whatsapp_templates', 'rooms_areas',
      'roles_management', 'users_management', 'settings',
    ]) {
      expect(hasPermission('viewer', DEFAULT_VIEWER, m, 'view')).toBe(false);
      expect(hasPermission('viewer', DEFAULT_VIEWER, m, 'edit')).toBe(false);
    }
  });

  // Manager policy as of 48af9c1: full operational access — view+edit on every
  // module EXCEPT settings / users_management / roles_management.
  it('manager (default matrix) has full operational access (view+edit)', () => {
    expect(hasPermission('manager', DEFAULT_MANAGER, 'import', 'view')).toBe(true);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'import', 'edit')).toBe(true);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'dashboard', 'edit')).toBe(true);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'status_management', 'view')).toBe(true);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'status_management', 'edit')).toBe(true);
    // …but still locked out of the admin-only line.
    expect(hasPermission('manager', DEFAULT_MANAGER, 'settings', 'edit')).toBe(false);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'users_management', 'view')).toBe(false);
  });

  it('a permission not present in the matrix is denied (fail-closed)', () => {
    expect(hasPermission('viewer', [], 'dashboard', 'view')).toBe(false);
    expect(hasPermission('manager', [], 'import', 'edit')).toBe(false);
  });
});

// Field-worker roles (migration 063). A worker is a NARROW role, not a senior
// one: tasks + issues, view+edit, and nothing else in the system.
describe('field-worker roles — cleaner / maintenance', () => {
  const WORKERS = ['cleaner', 'maintenance'] as const;

  it.each(WORKERS)('%s can view AND edit tasks + issues', (role) => {
    // edit is what lets a worker actually work: POST /api/tasks and every status
    // PATCH (התחל טיפול / השלם) are guarded on it.
    for (const m of ['tasks', 'issues']) {
      expect(hasPermission(role, DEFAULT_WORKER, m, 'view')).toBe(true);
      expect(hasPermission(role, DEFAULT_WORKER, m, 'edit')).toBe(true);
    }
  });

  it.each(WORKERS)('%s can reach NOTHING else — the whole blast radius', (role) => {
    for (const m of [
      'analytics', 'dashboard', 'contacts', 'suppliers', 'whatsapp',
      'calendar', 'documents', 'whatsapp_chat', 'internal_chat', 'user_reminders',
      'import', 'export', 'status_management', 'whatsapp_templates', 'rooms_areas',
      'roles_management', 'users_management', 'settings',
    ]) {
      expect(hasPermission(role, DEFAULT_WORKER, m, 'view')).toBe(false);
      expect(hasPermission(role, DEFAULT_WORKER, m, 'edit')).toBe(false);
    }
  });

  // The landmine this whole change is built around: getCurrentActor() only
  // queries user_permissions for a MATRIX role. If a worker role were not one,
  // it would silently load an empty permission set — locking the worker out of
  // the very screen we built for them, while every guard still returns a clean
  // 403. Assert the classification directly.
  it.each(WORKERS)('%s is a matrix role, is not elevated, and seeds the worker defaults', (role) => {
    expect(isMatrixRole(role)).toBe(true);
    expect(isElevatedRole(role)).toBe(false);
    expect(isWorkerRole(role)).toBe(true);
    expect(getDefaultPermissions(role)).toEqual(DEFAULT_WORKER);
  });

  it.each(WORKERS)('%s does not bypass the matrix (fail-closed on empty permissions)', (role) => {
    // Only super_admin / admin short-circuit hasPermission. A worker with no rows
    // gets nothing — never the admin fallthrough.
    expect(hasPermission(role, [], 'issues', 'view')).toBe(false);
    expect(hasPermission(role, [], 'settings', 'edit')).toBe(false);
    expect(hasPermission(role, [], 'users_management', 'view')).toBe(false);
  });

  it('an admin may create/manage workers; a worker may manage nobody', () => {
    for (const w of WORKERS) {
      expect(canManageRole('admin', w)).toBe(true);
      expect(canManageRole('super_admin', w)).toBe(true);
      // A worker is not a manager of anything — including other workers.
      for (const target of ROLE_VALUES) expect(canManageRole(w, target)).toBe(false);
    }
  });

  // A worker holds no `dashboard` and no overview-widget permission, so landing
  // them anywhere but /issues yields an empty (or bounced) page.
  it.each(WORKERS)('%s lands on /issues', (role) => {
    expect(homePathFor(role)).toBe('/issues');
  });

  it('the existing roles are untouched by the addition', () => {
    expect(homePathFor('viewer')).toBe('/dashboard');
    expect(homePathFor('manager')).toBe('/overview');
    expect(homePathFor('admin')).toBe('/overview');
    expect(getDefaultPermissions('manager')).toEqual(DEFAULT_MANAGER);
    expect(getDefaultPermissions('viewer')).toEqual(DEFAULT_VIEWER);
    expect(getDefaultPermissions('admin')).toBeNull();
    expect(getDefaultPermissions('super_admin')).toBeNull();
  });
});
