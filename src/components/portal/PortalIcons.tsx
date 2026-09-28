// The reference's inline SVGs (ref/Tenant Portal.html), verbatim — the portal
// draws its own glyphs so the screen matches the reference stroke for stroke;
// lucide is deliberately not used here (decision 28/09/2026, same as the
// login's building glyph).

type IconProps = { size?: number; strokeWidth?: number; className?: string };

function Svg({ size = 18, strokeWidth = 1.8, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** The top bar's building glyph (white on the brand tile). */
export function BuildingGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="12" height="18" rx="2" />
      <path d="M16 9h3a1 1 0 0 1 1 1v11h-4" />
      <path d="M8 7h4M8 11h4M8 15h4" />
    </svg>
  );
}

export function LogoutIcon(p: IconProps) {
  return <Svg {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" /></Svg>;
}

export function DocIcon(p: IconProps) {
  return <Svg size={16} {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></Svg>;
}

export function ExportIcon(p: IconProps) {
  return <Svg {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>;
}

export function WalletIcon(p: IconProps) {
  return <Svg strokeWidth={2} {...p}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 15h2" /></Svg>;
}

export function ArrowUpIcon(p: IconProps) {
  return <Svg strokeWidth={2} {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>;
}

export function ArrowDownIcon(p: IconProps) {
  return <Svg strokeWidth={2} {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></Svg>;
}

export function ScaleIcon(p: IconProps) {
  return <Svg strokeWidth={2} {...p}><path d="M12 3v18M5 7l7-2 7 2M3 14l2-7 2 7a2 2 0 0 1-4 0zM17 14l2-7 2 7a2 2 0 0 1-4 0zM8 21h8" /></Svg>;
}

/** "החלטות ועד" — the check-in-a-box glyph. */
export function DecisionsIcon(p: IconProps) {
  return <Svg size={22} {...p}><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></Svg>;
}

/** "דוחות" — the file-with-bars glyph. */
export function ReportsIcon(p: IconProps) {
  return <Svg size={28} {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 17v-3M12 17v-6M15 17v-2" /></Svg>;
}

/** "החשבון שלי" — a person card. */
export function AccountIcon(p: IconProps) {
  return <Svg size={28} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2.5" /><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3" /></Svg>;
}

export function InfoIcon(p: IconProps) {
  return <Svg size={16} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></Svg>;
}

export function ChevronIcon(p: IconProps) {
  return <Svg size={16} {...p}><path d="M6 9l6 6 6-6" /></Svg>;
}
