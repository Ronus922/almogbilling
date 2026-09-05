'use client';

// Root-level error boundary: a render error that escapes every page boundary
// lands here. Reports to Sentry (no-op without DSN) and shows a minimal RTL
// recovery screen — the root layout is not rendered when this shows, so the
// <html>/<body> tags are ours.
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="he" dir="rtl">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="flex max-w-md flex-col gap-4 rounded-lg border p-6 text-center">
          <h1 className="text-xl font-semibold">משהו השתבש</h1>
          <p className="text-sm text-muted-foreground">
            השגיאה דווחה. אפשר לנסות שוב, ואם זה חוזר — לרענן את הדף.
          </p>
          <button
            type="button"
            onClick={reset}
            className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            נסה שוב
          </button>
        </div>
      </body>
    </html>
  );
}
