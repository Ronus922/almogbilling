import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The UI layer of the tiered users-management model (07/10/2026):
//   • the nav shows "משתמשים" to admin and super_admin BY ROLE — and to no one
//     else, not even a manager carrying a users_management matrix row;
//   • the matrix renders the management tier locked for an admin (disabled,
//     "סופר אדמין בלבד"), open for a super admin;
//   • an invite card the viewer may not manage carries no action icons.

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { filterNav } from '@/components/app-shell/nav';
import { PermissionMatrix } from '@/components/settings/users/PermissionMatrix';
import { InviteCard } from '@/components/settings/users/InviteCard';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_MANAGER, type ModulePermission, type Role } from '@/lib/permissions/constants';

const navHrefs = (role: Role, perms: ModulePermission[] = []) =>
  filterNav(role, (m, a) => hasPermission(role, perms, m, a)).sections.flatMap((s) => s.items.map((i) => i.href));

describe('nav — "משתמשים" by role, never by the matrix', () => {
  it('admin and super_admin see it', () => {
    expect(navHrefs('admin')).toContain('/settings/users');
    expect(navHrefs('super_admin')).toContain('/settings/users');
  });

  it('a manager / viewer does not — even with a users_management row', () => {
    const row: ModulePermission[] = [...DEFAULT_MANAGER, { module: 'users_management', canView: true, canEdit: true }];
    expect(navHrefs('manager', row)).not.toContain('/settings/users');
    expect(navHrefs('viewer', row)).not.toContain('/settings/users');
    expect(navHrefs('cleaner', row)).not.toContain('/settings/users');
  });
});

describe('PermissionMatrix — the management tier', () => {
  const html = (actorRole: Role) =>
    renderToStaticMarkup(createElement(PermissionMatrix, { userId: 'u1', permissions: DEFAULT_MANAGER, actorRole }));
  const rowOf = (h: string, label: string) => {
    const at = h.indexOf(`>${label}`);
    return h.slice(at, h.indexOf('</tr>', at));
  };

  it('admin: users / permissions / settings are locked and say so; finance is not', () => {
    const h = html('admin');
    for (const label of ['ניהול משתמשים', 'הרשאות', 'הגדרות']) {
      const row = rowOf(h, label);
      expect(row).toContain('סופר אדמין בלבד');
      expect(row.match(/aria-disabled="true"/g)).toHaveLength(2);
    }
    const finance = rowOf(h, 'שקיפות כספית');
    expect(finance).not.toContain('סופר אדמין בלבד');
    expect(finance).not.toContain('aria-disabled');
  });

  it('super_admin: nothing is locked', () => {
    expect(html('super_admin')).not.toContain('סופר אדמין בלבד');
  });
});

describe('InviteCard — actions only within scope', () => {
  const invite = { id: 'i1', email: 'a@x.co', full_name: 'מוזמנת', role: 'admin' as Role, expires_at: '2026-10-14T00:00:00Z', created_at: '2026-10-07T00:00:00Z' };
  const html = (canManage: boolean) =>
    renderToStaticMarkup(createElement(InviteCard, { invite: invite as never, canManage, onResend: vi.fn(), onCancel: vi.fn() }));

  it('may manage → "שלח שוב" and "בטל הזמנה"', () => {
    const h = html(true);
    expect(h).toContain('aria-label="שלח שוב"');
    expect(h).toContain('aria-label="בטל הזמנה"');
  });

  it('may not → read-only: no action icons', () => {
    const h = html(false);
    expect(h).not.toContain('aria-label="שלח שוב"');
    expect(h).not.toContain('aria-label="בטל הזמנה"');
    expect(h).toContain('מוזמנת');
  });
});
