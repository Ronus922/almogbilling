import type { ComponentType, ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';

// Navigation icons — verbatim from the approved reference (ref/sidebar-rail/
// "Sidebar B - Rail.html"): 24×24 viewBox, round caps and joins, stroke-width 1.9.
// lucide-react 1.62 redrew almost every one of these shapes (credit-card gained a
// second stroke, shield and megaphone are new paths…), so only `LayoutGrid` is the
// same drawing and comes from lucide; every other icon carries the reference's
// own path data. Sizes are set by the caller: 19px on the rail, 16px in the panel.

export interface NavIconProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
}
export type NavIcon = ComponentType<NavIconProps>;

function svgIcon(name: string, children: ReactNode): NavIcon {
  const Icon = ({ className, size = 16, strokeWidth = 1.9 }: NavIconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

const GEAR_PATH =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

// ── Rail (19px) ──────────────────────────────────────────────────────────────
export const RailHome: NavIcon = LayoutGrid;
export const RailFinance = svgIcon('RailFinance', (
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
  </>
));
export const RailResidents = svgIcon('RailResidents', (
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </>
));
export const RailBroadcast = svgIcon('RailBroadcast', (
  <>
    <path d="m3 11 18-5v12L3 14v-3z" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </>
));
export const RailOps = svgIcon('RailOps', (
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
));
export const RailPurchasing = svgIcon('RailPurchasing', (
  <>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
  </>
));
export const RailPortal = svgIcon('RailPortal', (
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
));
export const RailSecurity = svgIcon('RailSecurity', (
  <>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="3.5" />
  </>
));
export const RailSettings = svgIcon('RailSettings', (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d={GEAR_PATH} />
  </>
));
export const RailLogout = svgIcon('RailLogout', (
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
));

/** The logo mark in the rail's 40×40 tile (20px, stroke 2). */
export const LogoMark = svgIcon('LogoMark', <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />);
/** The panel's collapse chevrons (15px, stroke 2). */
export const CollapseChevrons = svgIcon('CollapseChevrons', <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />);

// ── Panel items (16px) ───────────────────────────────────────────────────────
export const ItemGrid: NavIcon = LayoutGrid;
/** Same drawing on the rail (finance) and in the panel (billing management). */
export const ItemBill: NavIcon = RailFinance;
export const ItemChart = svgIcon('ItemChart', <path d="M4 21h16M6 21V9m6 12V5m6 16v-8" />);
export const ItemClock = svgIcon('ItemClock', (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
));
export const ItemList = svgIcon('ItemList', <path d="M4 6h16M4 12h10M4 18h7" />);
export const ItemUser = svgIcon('ItemUser', (
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
  </>
));
export const ItemChat = svgIcon('ItemChat', (
  <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8Z" />
));
export const ItemChatInternal = svgIcon('ItemChatInternal', (
  <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
));
export const ItemMegaphone = svgIcon('ItemMegaphone', <path d="m3 11 18-5v12L3 14v-3z" />);
export const ItemDoc = svgIcon('ItemDoc', (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </>
));
export const ItemClipboard = svgIcon('ItemClipboard', (
  <>
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" />
  </>
));
export const ItemCheck = svgIcon('ItemCheck', (
  <>
    <path d="m9 11 3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </>
));
export const ItemBell = svgIcon('ItemBell', <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />);
export const ItemCalendar = svgIcon('ItemCalendar', (
  <>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </>
));
export const ItemParking = svgIcon('ItemParking', (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M9 9h2v7H9zM9 9h4a2 2 0 1 1 0 4h-2" />
  </>
));
export const ItemPin = svgIcon('ItemPin', (
  <>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </>
));
export const ItemCart: NavIcon = RailPurchasing;
export const ItemTruck = svgIcon('ItemTruck', (
  <>
    <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </>
));
export const ItemKey = svgIcon('ItemKey', (
  <path d="M14 4.1 12 6M5.1 8 2.8 10.3a3 3 0 0 0 0 4.2l6.7 6.7a3 3 0 0 0 4.2 0L16 19M15 9l6-6M9 15l6-6" />
));
export const ItemShield = svgIcon('ItemShield', (
  <>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </>
));
export const ItemUserPlus = svgIcon('ItemUserPlus', (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M19 8v6M22 11h-6" />
  </>
));
export const ItemArchive = svgIcon('ItemArchive', <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />);
export const ItemScan = svgIcon('ItemScan', (
  <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
));
/** The reference's `gear` panel icon is a lone circle (a truncated copy of the rail's
 *  gear); the panel shows the same full gear as the rail instead. See DESIGN.md §14. */
export const ItemGear: NavIcon = RailSettings;
