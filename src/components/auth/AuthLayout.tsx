import type { ReactNode } from 'react';
import { FeaturesCard } from './FeaturesCard';
import { Card } from '@/components/ui/card';

type Variant = 'login' | 'forgot' | 'reset';

/**
 * Two-column auth layout (form-left, features-right) with a soft gradient backdrop.
 * Matches the Claude Design screens for /login, /forgot-password, /reset-password.
 * On mobile (<lg) the features panel collapses and only the form card is shown.
 */
export function AuthLayout({
  children,
  variant,
}: {
  children: ReactNode;
  variant: Variant;
}) {
  // RTL grid: first child → right column, second → left column.
  // We want features on the right, form on the left, so FeaturesCard comes first.
  return (
    <div className="auth-gradient flex min-h-screen w-full items-center justify-center px-4 py-10 md:px-12">
      <div className="grid w-full max-w-6xl items-center gap-12 lg:grid-cols-2">
        <FeaturesCard variant={variant} />
        <Card className="w-full max-w-md justify-self-center p-8 md:p-10 shadow-xl">
          {children}
        </Card>
      </div>
    </div>
  );
}
