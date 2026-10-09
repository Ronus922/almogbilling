import { describe, expect, it } from 'vitest';
import { filterNav } from '@/components/app-shell/nav';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// The "תפוצה" category (09/10/2026) is gated by the EXISTING permissions — no
// new module: sending (תפוצה חדשה, on both channels) = whatsapp_chat:edit, the
// history = whatsapp_chat:view, the templates = whatsapp_templates:view — the
// same predicates as the pages (src/app/(app)/broadcasts/**) and the routes
// (/api/whatsapp/campaigns, /api/whatsapp/templates). The UI layer of the three.

const section = (role: Role, perms: ModulePermission[] = []) =>
  filterNav(role, (m, a) => hasPermission(role, perms, m, a)).sections.find((s) => s.title === 'תפוצה');
const hrefs = (role: Role, perms: ModulePermission[] = []) => section(role, perms)?.items.map((i) => i.href) ?? [];

describe('nav — the "תפוצה" category', () => {
  it('admin / super_admin: new broadcast, templates, history', () => {
    for (const role of ['admin', 'super_admin'] as const) {
      expect(hrefs(role)).toEqual(['/broadcasts/new', '/whatsapp-templates', '/broadcasts/history']);
    }
  });

  it('a manager with the default matrix sees all three', () => {
    expect(hrefs('manager', DEFAULT_MANAGER)).toEqual(['/broadcasts/new', '/whatsapp-templates', '/broadcasts/history']);
  });

  it('view-only on whatsapp_chat: the history, never "תפוצה חדשה"', () => {
    const perms: ModulePermission[] = [{ module: 'whatsapp_chat', canView: true, canEdit: false }];
    expect(hrefs('manager', perms)).toEqual(['/broadcasts/history']);
  });

  it('templates alone follow whatsapp_templates', () => {
    const perms: ModulePermission[] = [{ module: 'whatsapp_templates', canView: true, canEdit: false }];
    expect(hrefs('manager', perms)).toEqual(['/whatsapp-templates']);
  });

  it('a viewer (default matrix) and a field worker: no category at all', () => {
    expect(section('viewer', DEFAULT_VIEWER)).toBeUndefined();
    expect(section('cleaner', [])).toBeUndefined();
  });

  it('the templates entry moved into the category — not duplicated in the main list', () => {
    const all = filterNav('admin', () => true).sections.flatMap((s) => s.items.map((i) => i.href));
    expect(all.filter((h) => h === '/whatsapp-templates')).toHaveLength(1);
    // The chat itself did not move.
    expect(filterNav('admin', () => true).sections[0].items.map((i) => i.href)).toContain('/messages');
  });
});
