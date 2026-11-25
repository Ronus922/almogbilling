import { describe, expect, it } from 'vitest';
import { filterNav, findActive, NAV_CATEGORIES } from '@/components/app-shell/nav';
import { canHandOverChips, canOpenUsersScreen, canViewVisitors, hasPermission } from '@/lib/permissions/check';
import {
  DEFAULT_MANAGER, DEFAULT_VIEWER, DEFAULT_WORKER,
  type Action, type ModulePermission, type Role,
} from '@/lib/permissions/constants';
import { PURCHASING_MODULES } from '@/lib/purchasing/access';

// Rail + panel navigation (11/11/2026): the single 24-item list became eight categories and a
// pinned "הגדרות". This is a navigation and design change ONLY — every item keeps the href,
// module, action and role gate it had. `OLD` below is the previous list, copied from nav.tsx as
// it stood before the change (labels left out on purpose: they are the one thing that moved).
// 24/11/2026 (Ronen): "צ׳יפים" moved from "כספים" to "אבטחה" — the item alone, with the same href
// and the same `chips` module gate, so the parity below still holds item by item.
// 25/11/2026 (Ronen): "מסירת צ׳יפים" (/chip-pickup) — a NEW item of "אבטחה", the guard's pickup
// screen, gated by role (CHIP_PICKUP_ROLES) exactly like the visitor scan. It is listed in OLD so
// the item-by-item comparison keeps covering every item of the menu.

type Can = (module: string, action: Action) => boolean;
interface OldItem {
  href: string;
  module?: string;
  action?: Action;
  visible?: (role: Role, can: Can) => boolean;
}

const OLD: OldItem[] = [
  { href: '/overview', visible: (role) => role !== 'viewer' && role !== 'guard' },
  { href: '/visitors', visible: (role) => canViewVisitors(role) },
  { href: '/chip-pickup', visible: (role) => canHandOverChips(role) },
  { href: '/dashboard', module: 'dashboard' },
  { href: '/contacts', module: 'contacts' },
  { href: '/messages', module: 'whatsapp_chat' },
  { href: '/chat', module: 'internal_chat' },
  { href: '/suppliers', module: 'suppliers' },
  { href: '/chips', module: 'chips' },
  { href: '/parking', module: 'parking' },
  { href: '/documents', module: 'documents' },
  { href: '/issues', module: 'issues' },
  { href: '/tasks', module: 'tasks' },
  { href: '/user-reminders', module: 'user_reminders' },
  { href: '/calendar', module: 'calendar' },
  { href: '/statuses', module: 'status_management' },
  { href: '/areas', module: 'rooms_areas' },
  { href: '/settings/users', visible: canOpenUsersScreen },
  { href: '/broadcasts/new', module: 'whatsapp_chat', action: 'edit' },
  { href: '/whatsapp-templates', module: 'whatsapp_templates' },
  { href: '/broadcasts/history', module: 'whatsapp_chat' },
  { href: '/finance', module: 'finance' },
  { href: '/finance/settings', module: 'finance' },
  { href: '/purchasing', visible: (_role, can) => PURCHASING_MODULES.some((m) => can(m, 'view')) },
  { href: '/decisions', module: 'portal_decisions' },
  { href: '/admin/portal-log', module: 'portal_manage' },
  // The old footer's "הגדרות".
  { href: '/settings', module: 'settings' },
];

const newItems = () => NAV_CATEGORIES.flatMap((c) => c.items);

describe('nav rail — nothing was lost, nothing was added', () => {
  it('every item of the old list exists once, with the same module / action / role gate', () => {
    expect(newItems()).toHaveLength(OLD.length);
    for (const old of OLD) {
      const found = newItems().filter((i) => i.href === old.href);
      expect(found, old.href).toHaveLength(1);
      expect(found[0]!.module, `${old.href} module`).toBe(old.module);
      expect(found[0]!.action, `${old.href} action`).toBe(old.action);
      expect(Boolean(found[0]!.visible), `${old.href} role gate`).toBe(Boolean(old.visible));
    }
  });

  const SCENARIOS: Array<[Role, string, ModulePermission[]]> = [
    ['super_admin', 'no rows', []],
    ['admin', 'no rows', []],
    ['manager', 'default matrix', DEFAULT_MANAGER],
    ['manager', 'no rows', []],
    ['viewer', 'default matrix', DEFAULT_VIEWER],
    ['cleaner', 'default matrix', DEFAULT_WORKER],
    ['maintenance', 'no rows', []],
    ['guard', 'no rows', []],
  ];

  it.each(SCENARIOS)('%s (%s) sees exactly the hrefs the old list showed', (role, _label, perms) => {
    const can: Can = (m, a) => hasPermission(role, perms, m, a);
    const oldHrefs = OLD.filter((o) => (o.visible ? o.visible(role, can) : o.module ? can(o.module, o.action ?? 'view') : true)).map((o) => o.href);
    const newHrefs = filterNav(role, can).categories.flatMap((c) => c.items.map((i) => i.href));
    expect([...newHrefs].sort()).toEqual([...oldHrefs].sort());
  });

  it('a "can everything" and a "can nothing" caller agree with the old list too', () => {
    for (const role of ['admin', 'viewer'] as const) {
      for (const all of [true, false]) {
        const can: Can = () => all;
        const oldHrefs = OLD.filter((o) => (o.visible ? o.visible(role, can) : o.module ? can(o.module, o.action ?? 'view') : true)).map((o) => o.href);
        const newHrefs = filterNav(role, can).categories.flatMap((c) => c.items.map((i) => i.href));
        expect([...newHrefs].sort()).toEqual([...oldHrefs].sort());
      }
    }
  });
});

describe('nav rail — the categories', () => {
  it('eight categories and a pinned settings, with the agreed labels, items and order', () => {
    expect(
      NAV_CATEGORIES.map((c) => ({ id: c.id, label: c.label, title: c.title, description: c.description, pinned: !!c.pinned, items: c.items.map((i) => i.label) })),
    ).toEqual([
      { id: 'home', label: 'ראשי', title: 'ראשי', description: 'מבט-על ופעולות מהירות', pinned: false, items: ['לוח מחוונים'] },
      { id: 'finance', label: 'כספים', title: 'כספים וחיובים', description: 'חיובים, גבייה ושקיפות כספית', pinned: false, items: ['ניהול חיובים', 'ניהול סטטוס חיובים', 'סקירה חודשית', 'סעיפים והגדרות'] },
      { id: 'residents', label: 'דיירים', title: 'דיירים ותקשורת', description: 'דיירים, צ׳אטים וחניות', pinned: false, items: ['רשימת דיירים', 'צ׳אט וואטסאפ', 'צ׳אט פנימי', 'חניות ומחסנים'] },
      { id: 'broadcasts', label: 'תפוצה', title: 'תפוצה', description: 'שליחת הודעות לדיירים', pinned: false, items: ['תפוצה חדשה', 'תבניות', 'היסטוריית תפוצות'] },
      { id: 'ops', label: 'תפעול', title: 'תפעול ואחזקה', description: 'תקלות, משימות ולו"ז', pinned: false, items: ['תקלות', 'משימות', 'תזכורות', 'יומן', 'ניהול אזורים'] },
      { id: 'purchasing', label: 'רכש', title: 'רכש וספקים', description: 'הצעות מחיר, הזמנות ומסמכים', pinned: false, items: ['בקשות והזמנות', 'ספקים', 'מסמכים'] },
      { id: 'portal', label: 'פורטל', title: 'פורטל בעלי דירות', description: 'שקיפות והרשאות לבעלי הדירות', pinned: false, items: ['החלטות ופרוטוקולים', 'התחברויות לפורטל', 'משתמשים'] },
      { id: 'security', label: 'אבטחה', title: 'אבטחה וביטחון', description: 'בקרת כניסה ומעקב', pinned: false, items: ['סריקת כניסה', 'מסירת צ׳יפים', 'צ׳יפים'] },
      { id: 'settings', label: 'הגדרות', title: 'הגדרות', description: 'הגדרות מערכת', pinned: true, items: ['הגדרות כלליות'] },
    ]);
  });

  it('the known routes sit where the brief put them', () => {
    const byHref = (href: string) => NAV_CATEGORIES.find((c) => c.items.some((i) => i.href === href))?.id;
    expect(byHref('/overview')).toBe('home');
    expect(byHref('/settings/users')).toBe('portal');
    expect(byHref('/broadcasts/new')).toBe('broadcasts');
    expect(byHref('/whatsapp-templates')).toBe('broadcasts');
    expect(byHref('/broadcasts/history')).toBe('broadcasts');
    expect(byHref('/chips')).toBe('security');
    expect(byHref('/suppliers')).toBe('purchasing');
    expect(byHref('/documents')).toBe('purchasing');
    expect(byHref('/visitors')).toBe('security');
    expect(byHref('/chip-pickup')).toBe('security');
  });

  it('a category with no permitted item is absent — the guard sees only security, the viewer only finance', () => {
    const ids = (role: Role, perms: ModulePermission[]) =>
      filterNav(role, (m, a) => hasPermission(role, perms, m, a)).categories.map((c) => c.id);
    expect(ids('guard', [])).toEqual(['security']);
    expect(ids('viewer', DEFAULT_VIEWER)).toEqual(['finance']);
    // "צ׳יפים" sits in "אבטחה" since 24/11/2026: whoever holds the chips module finds it there,
    // and "כספים" no longer lists it for anyone.
    const security = (role: Role, perms: ModulePermission[]) =>
      filterNav(role, (m, a) => hasPermission(role, perms, m, a)).categories.find((c) => c.id === 'security')?.items.map((i) => i.href);
    // The guard: the visitor scan and the pickup screen — never "צ׳יפים" itself.
    expect(security('guard', [])).toEqual(['/visitors', '/chip-pickup']);
    expect(security('guard', DEFAULT_MANAGER)).toEqual(['/visitors', '/chip-pickup']);
    expect(security('admin', [])).toEqual(['/visitors', '/chip-pickup', '/chips']);
    // A manager holds the chips module, and neither of the two role screens.
    expect(security('manager', DEFAULT_MANAGER)).toEqual(['/chips']);
    expect(security('viewer', DEFAULT_VIEWER)).toBeUndefined();
    for (const role of ['admin', 'manager'] as const) {
      const finance = filterNav(role, (m, a) => hasPermission(role, role === 'manager' ? DEFAULT_MANAGER : [], m, a)).categories.find((c) => c.id === 'finance');
      expect(finance?.items.map((i) => i.href)).not.toContain('/chips');
    }
    expect(ids('viewer', [])).toEqual([]);
    expect(ids('admin', [])).toEqual(NAV_CATEGORIES.map((c) => c.id));
  });

  it('the live count reaches the item that has a real source and no other', () => {
    const cats = filterNav('admin', () => true, { '/purchasing': 3 }).categories;
    const items = cats.flatMap((c) => c.items);
    expect(items.find((i) => i.href === '/purchasing')?.badge).toEqual({ count: 3, tone: 'warn' });
    expect(items.filter((i) => i.badge)).toHaveLength(1);
  });
});

describe('nav rail — which item (and category) is the current page', () => {
  const cats = filterNav('admin', () => true).categories;

  it('an item matches its path and everything under it', () => {
    expect(findActive(cats, '/issues')).toEqual({ categoryId: 'ops', href: '/issues' });
    expect(findActive(cats, '/issues/123')).toEqual({ categoryId: 'ops', href: '/issues' });
    expect(findActive(cats, '/broadcasts/history/abc')).toEqual({ categoryId: 'broadcasts', href: '/broadcasts/history' });
  });

  it('/finance is exact — the settings sub-page is its own item', () => {
    expect(findActive(cats, '/finance')).toEqual({ categoryId: 'finance', href: '/finance' });
    expect(findActive(cats, '/finance/settings')).toEqual({ categoryId: 'finance', href: '/finance/settings' });
  });

  it('where two items match, the longer href is the page (users is not "general settings")', () => {
    expect(findActive(cats, '/settings/users')).toEqual({ categoryId: 'portal', href: '/settings/users' });
    expect(findActive(cats, '/settings')).toEqual({ categoryId: 'settings', href: '/settings' });
    expect(findActive(cats, '/settings/whatsapp')).toEqual({ categoryId: 'settings', href: '/settings' });
  });

  it('a page in no category has no active item; a prefix that is not a path segment does not match', () => {
    expect(findActive(cats, '/notifications')).toBeNull();
    expect(findActive(cats, '/chatter')).toBeNull();
  });

  it('only items the user may see take part', () => {
    const viewerCats = filterNav('viewer', (m, a) => hasPermission('viewer', DEFAULT_VIEWER, m, a)).categories;
    expect(findActive(viewerCats, '/dashboard')).toEqual({ categoryId: 'finance', href: '/dashboard' });
    expect(findActive(viewerCats, '/overview')).toBeNull();
  });
});
