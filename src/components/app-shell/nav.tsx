import { PURCHASING_MODULES } from '@/lib/purchasing/access';
import type { Action, Role } from '@/lib/permissions/constants';
import { canOpenUsersScreen, canViewVisitors } from '@/lib/permissions/check';
import {
  ItemArchive, ItemBell, ItemBill, ItemCalendar, ItemCart, ItemChart, ItemChat, ItemChatInternal,
  ItemCheck, ItemClipboard, ItemClock, ItemDoc, ItemGear, ItemGrid, ItemKey, ItemList,
  ItemMegaphone, ItemParking, ItemPin, ItemScan, ItemShield, ItemTruck, ItemUser, ItemUserPlus,
  RailBroadcast, RailFinance, RailHome, RailOps, RailPortal, RailPurchasing, RailResidents,
  RailSecurity, RailSettings,
  type NavIcon,
} from './navIcons';

// Single source of truth for the app navigation — the categories, their items, and the
// role/permission filter. Consumed by BOTH the desktop Sidebar and the mobile drawer
// (MobileNav) through NavRail, so the two can never drift. Layout: a dark rail of
// category buttons + a white panel with the items of ONE category (DESIGN.md §14).

export type BadgeTone = 'default' | 'warn' | 'green';

export interface MenuItem {
  label: string;
  href?: string;
  icon: NavIcon;
  module?: string;
  /** The action the module check needs (default 'view') — e.g. "תפוצה חדשה"
   *  is for whoever may SEND (whatsapp_chat:edit), like its page and route. */
  action?: Action;
  /** Optional role/permission gate; when present it overrides the module-based
   *  `can` check. Used for /overview, which is role-gated (any non-viewer)
   *  rather than tied to a permission module; and for the users screen (admin /
   *  super_admin by role — canOpenUsersScreen, the page's own gate; never via
   *  the matrix). */
  visible?: (role: Role, can: (module: string, action: Action) => boolean) => boolean;
  /** Active only on the exact path (default: the path and everything under it).
   *  For a module's overview item whose sibling lives under the same prefix
   *  (/finance vs /finance/settings) — otherwise both light up together. */
  exact?: boolean;
  /** Live count badge. Rendered ONLY when a real source sets `count`. No item
   *  carries a hard-coded demo number — the badge capability stays dormant
   *  until a real data source is wired (see DESIGN.md §14). */
  badge?: { count: number; tone?: BadgeTone };
}

export interface NavCategory {
  id: string;
  /** The rail button's text (one short word). */
  label: string;
  /** The panel's heading. */
  title: string;
  /** The panel's one-line description. */
  description: string;
  /** The rail icon (19px). */
  icon: NavIcon;
  /** Pinned categories sit at the bottom of the rail, outside its scroll area. */
  pinned?: boolean;
  items: MenuItem[];
}

// Every item keeps the route + permission module (+ action / role gate) it had in the single
// list this replaced, so RBAC stays 1:1 — an unpermitted item just hides, and a category with
// no permitted item hides itself. tests/nav-rail-parity.test.ts pins that, item by item.
export const NAV_CATEGORIES: NavCategory[] = [
  {
    id: 'home',
    label: 'ראשי',
    title: 'ראשי',
    description: 'מבט-על ופעולות מהירות',
    icon: RailHome,
    items: [
      // The overview is for the roles that land on it: not the viewer (debtors screen
      // only) and not the guard (visitor scan only) — homePathFor() sends both away.
      { label: 'לוח מחוונים', icon: ItemGrid, href: '/overview', visible: (role) => role !== 'viewer' && role !== 'guard' },
    ],
  },
  {
    id: 'finance',
    label: 'כספים',
    title: 'כספים וחיובים',
    description: 'חיובים, גבייה ושקיפות כספית',
    icon: RailFinance,
    items: [
      { label: 'ניהול חיובים', icon: ItemBill, href: '/dashboard', module: 'dashboard' },
      { label: 'ניהול סטטוס חיובים', icon: ItemChart, href: '/statuses', module: 'status_management' },
      // Finance transparency ("שקיפות כספית") — both items sit on the `finance` module
      // (admin / super_admin in slice A).
      { label: 'סקירה חודשית', icon: ItemClock, href: '/finance', module: 'finance', exact: true },
      { label: 'סעיפים והגדרות', icon: ItemList, href: '/finance/settings', module: 'finance' },
      { label: 'צ׳יפים', icon: ItemArchive, href: '/chips', module: 'chips' },
    ],
  },
  {
    id: 'residents',
    label: 'דיירים',
    title: 'דיירים ותקשורת',
    description: 'דיירים, צ׳אטים וחניות',
    icon: RailResidents,
    items: [
      { label: 'רשימת דיירים', icon: ItemUser, href: '/contacts', module: 'contacts' },
      { label: 'צ׳אט וואטסאפ', icon: ItemChat, href: '/messages', module: 'whatsapp_chat' },
      { label: 'צ׳אט פנימי', icon: ItemChatInternal, href: '/chat', module: 'internal_chat' },
      { label: 'חניות ומחסנים', icon: ItemParking, href: '/parking', module: 'parking' },
    ],
  },
  // Broadcasts ("תפוצה", 09/10/2026) — one category for both channels (WhatsApp / email /
  // SMS): compose with a channel selector, the shared templates, one history. Sending and the
  // history are whatsapp_chat (edit / view) — the same gates as the pages and
  // /api/whatsapp/campaigns — and the templates screen is whatsapp_templates. The chat's own
  // "תפוצות" window stays where it was.
  {
    id: 'broadcasts',
    label: 'תפוצה',
    title: 'תפוצה',
    description: 'שליחת הודעות לדיירים',
    icon: RailBroadcast,
    items: [
      { label: 'תפוצה חדשה', icon: ItemMegaphone, href: '/broadcasts/new', module: 'whatsapp_chat', action: 'edit' },
      { label: 'תבניות', icon: ItemDoc, href: '/whatsapp-templates', module: 'whatsapp_templates' },
      { label: 'היסטוריית תפוצות', icon: ItemClock, href: '/broadcasts/history', module: 'whatsapp_chat' },
    ],
  },
  {
    id: 'ops',
    label: 'תפעול',
    title: 'תפעול ואחזקה',
    description: 'תקלות, משימות ולו"ז',
    icon: RailOps,
    items: [
      // Two separate screens (12/10/2026, Decisions Log: "עיצוב משותף, ישויות נפרדות"
      // cancels the 11/10/2026 unification into one /work nav item).
      { label: 'תקלות', icon: ItemClipboard, href: '/issues', module: 'issues' },
      { label: 'משימות', icon: ItemCheck, href: '/tasks', module: 'tasks' },
      { label: 'תזכורות', icon: ItemBell, href: '/user-reminders', module: 'user_reminders' },
      { label: 'יומן', icon: ItemCalendar, href: '/calendar', module: 'calendar' },
      { label: 'ניהול אזורים', icon: ItemPin, href: '/areas', module: 'rooms_areas' },
    ],
  },
  // Purchasing ("רכש", 21/10/2026) — requests for quotation + purchase orders. Keys
  // `purchasing_requests` / `purchasing_orders`: admins by role, everyone else by a per-user
  // grant. Suppliers and documents keep their own modules.
  {
    id: 'purchasing',
    label: 'רכש',
    title: 'רכש וספקים',
    description: 'הצעות מחיר, הזמנות ומסמכים',
    icon: RailPurchasing,
    items: [
      // Shown for ANY purchasing permission (requests or orders, view or more).
      {
        label: 'בקשות והזמנות', icon: ItemCart, href: '/purchasing',
        visible: (_role, can) => PURCHASING_MODULES.some((m) => can(m, 'view')),
      },
      { label: 'ספקים', icon: ItemTruck, href: '/suppliers', module: 'suppliers' },
      { label: 'מסמכים', icon: ItemDoc, href: '/documents', module: 'documents' },
    ],
  },
  // Owners portal ("פורטל בעלי דירות") — the decisions & protocols the portal publishes
  // (`portal_decisions`), the log of every login attempt (`portal_manage`), and the users
  // screen (by ROLE: admin / super_admin — canOpenUsersScreen, the page's own gate; never via
  // the matrix; 07/10/2026). The identity-approval screen was removed outright on 17/10/2026.
  {
    id: 'portal',
    label: 'פורטל',
    title: 'פורטל בעלי דירות',
    description: 'שקיפות והרשאות לבעלי הדירות',
    icon: RailPortal,
    items: [
      { label: 'החלטות ופרוטוקולים', icon: ItemKey, href: '/decisions', module: 'portal_decisions' },
      { label: 'התחברויות לפורטל', icon: ItemShield, href: '/admin/portal-log', module: 'portal_manage' },
      { label: 'משתמשים', icon: ItemUserPlus, href: '/settings/users', visible: canOpenUsersScreen },
    ],
  },
  // Visitor ID scan (08/11/2026) — by ROLE (VISITOR_VIEW_ROLES: guard, admin and super admin
  // only, since 09/11/2026; no other role sees the item). The guard's ONLY nav entry.
  {
    id: 'security',
    label: 'אבטחה',
    title: 'אבטחה וביטחון',
    description: 'בקרת כניסה ומעקב',
    icon: RailSecurity,
    items: [
      { label: 'סריקת כניסה', icon: ItemScan, href: '/visitors', visible: (role) => canViewVisitors(role) },
    ],
  },
  // Pinned to the bottom of the rail (next to "יציאה"), gated by the `settings` module.
  {
    id: 'settings',
    label: 'הגדרות',
    title: 'הגדרות',
    description: 'הגדרות מערכת',
    icon: RailSettings,
    pinned: true,
    items: [{ label: 'הגדרות כלליות', icon: ItemGear, href: '/settings', module: 'settings' }],
  },
];

// Hidden from the nav 2026-06-18 and still hidden: data import/export ('ייבוא נתונים' /import,
// module `import`; 'ייצוא נתונים', module `export`). Pages, routes, import_runs and all logic
// remain intact and the routes stay reachable by URL; restore = add the two items to a category.

/** The ONE nav-visibility filter — role-gated items override the module `can` check; a
 *  category with no permitted items hides itself. Both nav surfaces call this, so desktop
 *  and mobile always show the exact same set. */
export function filterNav(
  role: Role,
  can: (module: string, action: Action) => boolean,
  /** Live counts by item href — the badge shows only where a real source gave one. */
  counts: Record<string, number> = {},
): { categories: NavCategory[] } {
  const isVisible = (it: MenuItem) =>
    it.visible ? it.visible(role, can) : it.module ? can(it.module, it.action ?? 'view') : true;
  const categories = NAV_CATEGORIES
    .map((c) => ({
      ...c,
      items: c.items.filter(isVisible).map((it) => {
        const count = it.href ? counts[it.href] : undefined;
        return count ? { ...it, badge: { count, tone: 'warn' as const } } : it;
      }),
    }))
    .filter((c) => c.items.length > 0);
  return { categories };
}

/** How a category behaves in the rail — decided AFTER the permission filter, per user, in this
 *  one place for the desktop sidebar and the mobile drawer:
 *   · 'link'  — exactly one permitted item: the rail button IS that item (a direct link to its
 *     page, no panel, no sub-menu). The item is `category.items[0]`.
 *   · 'panel' — two or more: the rail button switches the panel's list, it never navigates.
 *  (A category with no permitted item is already gone — filterNav drops it.) */
export type NavCategoryKind = 'link' | 'panel';
export function categoryKind(category: Pick<NavCategory, 'items'>): NavCategoryKind {
  return category.items.length === 1 ? 'link' : 'panel';
}

function matchesPath(item: MenuItem, pathname: string): boolean {
  return !!item.href && (pathname === item.href || (!item.exact && pathname.startsWith(item.href + '/')));
}

/** The item of the current page, and the category that holds it — null when the page is in
 *  no category. An item matches on its path and everything under it (unless `exact`); where
 *  two items match (/settings and /settings/users), the longer href is the page's own. */
export function findActive(
  categories: NavCategory[],
  pathname: string,
): { categoryId: string; href: string } | null {
  let best: { categoryId: string; href: string } | null = null;
  for (const c of categories) {
    for (const it of c.items) {
      if (it.href && matchesPath(it, pathname) && (!best || it.href.length > best.href.length)) {
        best = { categoryId: c.id, href: it.href };
      }
    }
  }
  return best;
}
