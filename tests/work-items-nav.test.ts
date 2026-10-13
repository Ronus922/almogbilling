import { describe, expect, it } from 'vitest';
import { filterNav } from '@/components/app-shell/nav';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_MANAGER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// "תקלות"/"משימות" nav items (13/10/2026, decision 4: "הרשאות קובעות, לא
// תפקיד") — the nav's own filter (filterNav + hasPermission) already drives
// visibility entirely off the issues/tasks module permission, with no
// role-name special case anywhere in SECTIONS for these two items (nav.tsx).
// A manager/worker without an effective view permission already does not see
// the item; admin/super_admin see it because hasPermission grants them every
// module that is not in SUPER_ADMIN_ONLY — issues/tasks are not in that list,
// matching the project's standing "admin has every module" model (RBAC
// history: PR #78/#79/#93). This locks that behavior down so a future SECTIONS
// edit cannot silently special-case either role back in.

const hrefs = (role: Role, perms: ModulePermission[] = []) =>
  filterNav(role, (m, a) => hasPermission(role, perms, m, a)).sections
    .flatMap((s) => s.items)
    .map((i) => i.href);

describe('nav — תקלות/משימות visibility follows the module permission, not the role', () => {
  it('admin and super_admin always see both', () => {
    for (const role of ['admin', 'super_admin'] as const) {
      expect(hrefs(role)).toEqual(expect.arrayContaining(['/issues', '/tasks']));
    }
  });

  it('a manager with zero permission rows sees neither — even though "manager" sounds senior', () => {
    const navHrefs = hrefs('manager', []);
    expect(navHrefs).not.toContain('/issues');
    expect(navHrefs).not.toContain('/tasks');
  });

  it('a manager with the default matrix sees both', () => {
    expect(hrefs('manager', DEFAULT_MANAGER)).toEqual(expect.arrayContaining(['/issues', '/tasks']));
  });

  it('a manager granted issues alone sees only /issues', () => {
    const perms: ModulePermission[] = [{ module: 'issues', canView: true, canEdit: false }];
    const navHrefs = hrefs('manager', perms);
    expect(navHrefs).toContain('/issues');
    expect(navHrefs).not.toContain('/tasks');
  });

  it('a field worker with the default matrix sees both; with zero rows sees neither', () => {
    expect(hrefs('cleaner', DEFAULT_WORKER)).toEqual(expect.arrayContaining(['/issues', '/tasks']));
    const navHrefs = hrefs('maintenance', []);
    expect(navHrefs).not.toContain('/issues');
    expect(navHrefs).not.toContain('/tasks');
  });

  it('a viewer with no row on either module sees neither', () => {
    const navHrefs = hrefs('viewer', []);
    expect(navHrefs).not.toContain('/issues');
    expect(navHrefs).not.toContain('/tasks');
  });
});
