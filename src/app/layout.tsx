import type { Metadata } from 'next';
import { Heebo, IBM_Plex_Mono, Inter } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
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
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${inter.variable} ${chipMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
