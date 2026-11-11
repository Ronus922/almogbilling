import { describe, expect, it } from 'vitest';
import { filterNav } from '@/components/app-shell/nav';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_MANAGER } from '@/lib/permissions/constants';

// "טלפונים חסומים" (16/10/2026) lost its own nav entry once the blocked-phone
// identities section moved into /contacts — a separate menu item pointing at
// the same href as "רשימת דיירים" was a pure duplicate. The whole mechanism
// (and /admin/portal-blocked itself) was removed outright on 17/10/2026,
// "פישוט גישת פורטל" — this file only still checks that the nav stayed clean.

const section = (role: 'admin' | 'super_admin' | 'manager') =>
  filterNav(role, (m, a) => (role === 'manager' ? hasPermission(role, DEFAULT_MANAGER, m, a) : true))
    .categories.find((c) => c.id === 'portal');

describe('nav — "טלפונים חסומים" removed, no duplicate of /contacts', () => {
  it('the owners-portal category no longer lists "טלפונים חסומים" (it holds "משתמשים" since 11/11/2026)', () => {
    for (const role of ['admin', 'super_admin'] as const) {
      const items = section(role)?.items ?? [];
      expect(items.map((i) => i.label)).not.toContain('טלפונים חסומים');
      expect(items.map((i) => i.href)).toEqual(['/decisions', '/admin/portal-log', '/settings/users']);
    }
  });

  it('no nav item anywhere points at /admin/portal-blocked or duplicates /contacts', () => {
    const all = filterNav('super_admin', () => true).categories.flatMap((c) => c.items);
    expect(all.some((i) => i.href === '/admin/portal-blocked')).toBe(false);
    expect(all.filter((i) => i.href === '/contacts')).toHaveLength(1);
  });
});
