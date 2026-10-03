import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { Toaster } from '@/components/ui/sonner';
import { InstallPrompt } from '@/components/app-shell/InstallPrompt';
import './globals.css';

// The fonts are self-hosted (03/10/2026): the woff2 files are in src/fonts —
// copied from Fontsource's npm packages, each folder with its OFL.txt — so the
// build never reaches Google Fonts (which used to fail CI at random). Same
// families, weights, CSS variables and display as the Google-hosted setup
// they replace, and the SAME family names, because the CSS also names them
// literally ('Heebo' in buttons.css, print.css and the portal skin).
//
// THE CONST NAMES ARE THE FAMILY NAMES: next/font/local names the family (and
// its "<name> Fallback" face) after the variable it is assigned to. `Heebo`
// and `Inter` stay exactly what Google served; the chips' mono font is
// `IBMPlexMono` (only ever read through --font-chip-mono).
//
// One file = one subset, and next/font/local has no per-file unicode-range,
// so Heebo's Hebrew subset is a second call that declares the family 'Heebo'
// itself; the browser stitches the two by unicode-range. Only the call that
// owns --font-heebo generates the "Heebo Fallback" face. The variable files cover
// 100–900; the declared ranges keep today's weights (a 900 still resolves to
// Heebo's 800, as it did with the static files). next/font takes literals
// only, so each unicode-range is written out in full: Fontsource's "latin"
// and "hebrew" ranges, the same ones Google serves for those subsets.

const Heebo = localFont({
  src: '../fonts/heebo/heebo-latin-wght-normal.woff2',
  weight: '400 800',
  display: 'swap',
  variable: '--font-heebo',
  declarations: [
    { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const HeeboHebrew = localFont({
  src: '../fonts/heebo/heebo-hebrew-wght-normal.woff2',
  weight: '400 800',
  display: 'swap',
  variable: '--font-heebo-hebrew',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Heebo'" },
    { prop: 'unicode-range', value: 'U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F' },
  ],
});

// Inter — used for numbers, amounts and phones via the `font-num` utility
// (tabular-nums) so figures align cleanly. Its latin subset has no ₪ (U+20AA):
// the shekel sign of every amount comes from the latin-ext file, a second call
// that declares the family 'Inter' itself, like Heebo's Hebrew above.
const Inter = localFont({
  src: '../fonts/inter/inter-latin-wght-normal.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-inter',
  declarations: [
    { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const InterLatinExt = localFont({
  src: '../fonts/inter/inter-latin-ext-wght-normal.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-inter-latin-ext',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Inter'" },
    { prop: 'unicode-range', value: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
});

// IBM Plex Mono — SCOPED to the chips module only (declared exception,
// DESIGN.md "מודול צ'יפים"): chip numbers/phones there render via the
// `.chip-num` class inside `.chips-skin`. The global `font-num` stays Inter.
const IBMPlexMono = localFont({
  src: [
    { path: '../fonts/ibm-plex-mono/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/ibm-plex-mono/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-chip-mono',
  declarations: [
    { prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});

export const metadata: Metadata = {
  title: 'ALMOG CRM',
  description: 'מערכת ניהול דיירים וגבייה לחברות ניהול בניינים',
  manifest: '/manifest.webmanifest',
  // Two icon geometries (see public/icons/README.md): the ICO carries the
  // simplified ≤48px mark, the SVG serves modern browsers at any density.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/icon-180.png',
    other: [{ rel: 'mask-icon', url: '/icons/mark-mono.svg', color: '#3D5AFE' }],
  },
  // iOS reads these metas (not only the manifest) for Home-Screen installs.
  appleWebApp: {
    capable: true,
    title: 'אלמוג',
    statusBarStyle: 'default',
  },
};

// `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` return non-zero
// on notched devices — without it the whole safe-area layer is dead CSS. Next's
// default viewport tag omits it. No `maximum-scale`/`user-scalable`: pinch-zoom
// stays available (a11y), and iOS focus-zoom is prevented by the field font
// floor in styles/responsive.css, not by locking the viewport.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#3D5AFE',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" className={`${Heebo.variable} ${HeeboHebrew.variable} ${Inter.variable} ${InterLatinExt.variable} ${IBMPlexMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
        <InstallPrompt />
      </body>
    </html>
  );
}
