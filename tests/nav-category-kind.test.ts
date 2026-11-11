import { describe, expect, it } from 'vitest';
import { categoryKind, filterNav, NAV_CATEGORIES, type NavCategory } from '@/components/app-shell/nav';
import { hasPermission } from '@/lib/permissions/check';
import {
  DEFAULT_VIEWER,
  type Action, type ModulePermission, type Role,
} from '@/lib/permissions/constants';

// Link category vs panel category (11/11/2026, second round; DESIGN.md §14): a category that is
// left with ONE permitted item is a direct link in the rail (no panel); two or more are a panel
// category; none is not shown. The kind is decided AFTER the permission filter, per user — so a
// category with several items in the config can be a link for a user who may see just one.

type Can = (module: string, action: Action) => boolean;
const canOf = (role: Role, perms: ModulePermission[]): Can => (m, a) => hasPermission(role, perms, m, a);

/** id → kind (and the link's href) for what this user sees. */
function kinds(role: Role, can: Can): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of filterNav(role, can).categories) {
    out[c.id] = categoryKind(c) === 'link' ? `link:${c.items[0]!.href}` : 'panel';
  }
  return out;
}

describe('nav category kind — decided after the permission filter', () => {
  it('a super admin: single-item categories are links, the rest are panels', () => {
    expect(kinds('super_admin', canOf('super_admin', []))).toEqual({
      home: 'link:/overview',
      finance: 'panel',
      residents: 'panel',
      broadcasts: 'panel',
      ops: 'panel',
      purchasing: 'panel',
      portal: 'panel',
      security: 'link:/visitors',
      settings: 'link:/settings',
    });
  });

  it('the guard sees one category, "אבטחה", and it is a link to /visitors', () => {
    expect(kinds('guard', canOf('guard', []))).toEqual({ security: 'link:/visitors' });
  });

  it('a multi-item category that permissions cut down to one item becomes a link with that item', () => {
    // The viewer's default matrix leaves the finance category only the debtors screen.
    expect(kinds('viewer', canOf('viewer', DEFAULT_VIEWER))).toEqual({ finance: 'link:/dashboard' });

    // Someone who may open only the residents list (no chats, no parking). The viewer role has
    // no overview, so nothing else shows.
    const onlyContacts: Can = (m, a) => m === 'contacts' && a === 'view';
    expect(kinds('viewer', onlyContacts)).toEqual({ residents: 'link:/contacts' });

    // Purchasing with suppliers only (no requests/orders, no documents).
    const onlySuppliers: Can = (m, a) => m === 'suppliers' && a === 'view';
    expect(kinds('viewer', onlySuppliers)).toEqual({ purchasing: 'link:/suppliers' });
  });

  it('two permitted items are enough for a panel', () => {
    const contactsAndParking: Can = (m, a) => (m === 'contacts' || m === 'parking') && a === 'view';
    expect(kinds('viewer', contactsAndParking)).toEqual({ residents: 'panel' });
  });

  it('a category with no permitted item is not shown at all', () => {
    expect(kinds('viewer', canOf('viewer', []))).toEqual({});
    expect(kinds('viewer', () => false)).toEqual({});
    // The overview is role-gated, not matrix-gated: a manager with an empty matrix still has it.
    expect(kinds('manager', () => false)).toEqual({ home: 'link:/overview' });
  });

  it('the kind follows the item count and nothing else — also for an item that is not wired yet', () => {
    const soon: Pick<NavCategory, 'items'> = { items: [{ label: 'בקרוב', icon: NAV_CATEGORIES[0]!.items[0]!.icon }] };
    expect(categoryKind(soon)).toBe('link');
    expect(categoryKind({ items: [] })).toBe('panel');
    expect(categoryKind({ items: [...soon.items, ...soon.items] })).toBe('panel');
  });

  it('desktop and mobile read the same single function — the filter result is the only input', () => {
    // The kind is derived from the filtered items alone, so a second filterNav call (the drawer's)
    // cannot disagree with the first (the sidebar's) for the same user.
    const can = canOf('manager', []);
    expect(kinds('manager', can)).toEqual(kinds('manager', can));
    for (const c of filterNav('super_admin', () => true).categories) {
      expect(categoryKind(c)).toBe(c.items.length === 1 ? 'link' : 'panel');
    }
  });
});
