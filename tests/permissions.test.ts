import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_VIEWER, DEFAULT_MANAGER } from '@/lib/permissions/constants';

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
