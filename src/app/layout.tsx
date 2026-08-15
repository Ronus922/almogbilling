import type { Metadata, Viewport } from 'next';
import { Heebo, IBM_Plex_Mono, Inter } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { InstallPrompt } from '@/components/app-shell/InstallPrompt';
import './globals.css';

const heebo = Heebo({
  variable: '--font-heebo',
  subsets: ['hebrew', 'latin'],
  weight: ['400', '500', '600', '700', '800'],
});

// Inter — used for numbers, amounts and phones via the `font-num` utility
// (tabular-nums) so figures align cleanly.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

// IBM Plex Mono — SCOPED to the chips module only (declared exception,
// DESIGN.md "מודול צ'יפים"): chip numbers/phones there render via the
// `.chip-num` class inside `.chips-skin`. The global `font-num` stays Inter.
const chipMono = IBM_Plex_Mono({
  variable: '--font-chip-mono',
  subsets: ['latin'],
  weight: ['500', '600'],
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
    <html lang="he" dir="rtl" className={`${heebo.variable} ${inter.variable} ${chipMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
        <InstallPrompt />
      </body>
    </html>
  );
}
