import { describe, it, expect } from 'vitest';
import {
  canCreateVisitorScan, canEditVisitorNotes, canManageRole, canManageVisitorScans, canUseAssistant,
  canUseNotifications, canViewVisitors, hasAnyAccess, hasPermission,
} from '@/lib/permissions/check';
import {
  MODULES, ROLES, ROLE_VALUES, isElevatedRole, isGuardRole, isMatrixRole, roleLabel,
  VISITOR_CREATE_ROLES, VISITOR_MANAGE_ROLES, VISITOR_VIEW_ROLES, type Role,
} from '@/lib/permissions/constants';
import { homePathFor } from '@/lib/auth/home';

// The guard ("שומר", 08/11/2026): the seventh role, the lowest, with ONE screen.
// Every rule here is a role-allowlist, so a role added later is denied until it
// is listed on purpose.

const ALL: readonly Role[] = ROLE_VALUES;
const STAFF_WITH_SCREEN_ONLY_FOR_GUARD: readonly Role[] = ['guard'];

describe('the guard role', () => {
  it('is the seventh role, below viewer, labelled שומר', () => {
    expect(ROLES).toHaveLength(7);
    expect(ROLE_VALUES).toContain('guard');
    expect(roleLabel('guard')).toBe('שומר');
    const level = (r: Role) => ROLES.find((x) => x.value === r)!.level;
    expect(level('guard')).toBeLessThan(level('viewer'));
    expect(level('guard')).toBeLessThan(level('cleaner'));
  });

  it('is neither a matrix role nor an elevated one', () => {
    expect(isMatrixRole('guard')).toBe(false);
    expect(isElevatedRole('guard')).toBe(false);
    expect(isGuardRole('guard')).toBe(true);
    for (const r of ALL.filter((x) => x !== 'guard')) expect(isGuardRole(r)).toBe(false);
  });

  it('holds no module permission, whatever rows exist — even a hand-written full matrix', () => {
    const everything = MODULES.map((m) => ({ module: m.key, canView: true, canEdit: true }));
    for (const m of MODULES) {
      for (const action of ['view', 'edit'] as const) {
        expect(hasPermission('guard', [], m.key, action)).toBe(false);
        // The actor loader never reads rows for a non-matrix role, and if one were handed in
        // anyway hasPermission still refuses: the guard is closed in two places, not one.
        expect(hasPermission('guard', everything, m.key, action)).toBe(false);
      }
    }
    // Sanity: the same rows DO open a matrix role — the guard is closed by what it is.
    expect(hasPermission('viewer', everything, 'finance', 'view')).toBe(true);
  });

  it('is managed by an admin (a non-elevated role) but manages nobody', () => {
    expect(canManageRole('admin', 'guard')).toBe(true);
    expect(canManageRole('super_admin', 'guard')).toBe(true);
    for (const r of ALL) expect(canManageRole('guard', r)).toBe(false);
    expect(canManageRole('manager', 'guard')).toBe(false);
  });

  it('lands on /visitors, passes the zero-access gate, and has no bell or assistant', () => {
    expect(homePathFor('guard')).toBe('/visitors');
    expect(hasAnyAccess('guard', [])).toBe(true);
    expect(canUseNotifications('guard')).toBe(false);
    expect(canUseNotifications('viewer')).toBe(false);
    for (const r of ALL.filter((x) => x !== 'guard' && x !== 'viewer')) expect(canUseNotifications(r)).toBe(true);
    expect(canUseAssistant('guard', [{ module: 'dashboard', canView: true, canEdit: true }])).toBe(false);
  });

  it('does not change where anyone else lands', () => {
    expect(homePathFor('viewer')).toBe('/dashboard');
    expect(homePathFor('cleaner')).toBe('/issues');
    expect(homePathFor('maintenance')).toBe('/issues');
    expect(homePathFor('manager')).toBe('/overview');
    expect(homePathFor('admin')).toBe('/overview');
    expect(homePathFor('super_admin')).toBe('/overview');
    // a matrix role with no rows is still sent to /no-access
    expect(hasAnyAccess('viewer', [])).toBe(false);
  });
});

describe('the visitor-scan allowlists', () => {
  it('only guard, admin and super admin may view the screen, the rows and the photo', () => {
    const allowed = new Set<Role>(['guard', 'admin', 'super_admin']);
    for (const r of ALL) expect(canViewVisitors(r)).toBe(allowed.has(r));
    expect([...VISITOR_VIEW_ROLES].sort()).toEqual(['admin', 'guard', 'super_admin']);
  });

  it('manager, viewer, cleaner and maintenance have no access of any kind (09/11/2026)', () => {
    for (const r of ['manager', 'viewer', 'cleaner', 'maintenance'] as const) {
      expect(canViewVisitors(r)).toBe(false);
      expect(canCreateVisitorScan(r)).toBe(false);
      expect(canEditVisitorNotes(r)).toBe(false);
      expect(canManageVisitorScans(r)).toBe(false);
    }
  });

  it('seeing the log is never wider than writing to it', () => {
    for (const r of ALL) {
      if (canCreateVisitorScan(r) || canEditVisitorNotes(r) || canManageVisitorScans(r)) expect(canViewVisitors(r)).toBe(true);
    }
  });

  it('only guard, admin and super admin scan and write notes', () => {
    const allowed = new Set<Role>(['guard', 'admin', 'super_admin']);
    for (const r of ALL) {
      expect(canCreateVisitorScan(r)).toBe(allowed.has(r));
      expect(canEditVisitorNotes(r)).toBe(allowed.has(r));
    }
    expect([...VISITOR_CREATE_ROLES].sort()).toEqual(['admin', 'guard', 'super_admin']);
  });

  it('only admin and super admin edit every field and delete — never the guard', () => {
    const allowed = new Set<Role>(['admin', 'super_admin']);
    for (const r of ALL) expect(canManageVisitorScans(r)).toBe(allowed.has(r));
    expect([...VISITOR_MANAGE_ROLES].sort()).toEqual(['admin', 'super_admin']);
    for (const r of STAFF_WITH_SCREEN_ONLY_FOR_GUARD) expect(canManageVisitorScans(r)).toBe(false);
  });

  it('a role added later is denied everywhere until listed (fail-closed)', () => {
    const future = 'resident' as Role;
    expect(canViewVisitors(future)).toBe(false);
    expect(canCreateVisitorScan(future)).toBe(false);
    expect(canEditVisitorNotes(future)).toBe(false);
    expect(canManageVisitorScans(future)).toBe(false);
  });
});
