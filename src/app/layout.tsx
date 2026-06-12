import type { Metadata } from 'next';
import { Heebo, Inter } from 'next/font/google';
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

export const metadata: Metadata = {
  title: 'ALMOG CRM',
  description: 'מערכת ניהול דיירים וגבייה לחברות ניהול בניינים',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${inter.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
