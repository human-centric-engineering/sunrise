'use client';

/**
 * Public Routes Error Boundary
 *
 * Catches errors that occur within public routes (landing, about, contact, etc.).
 * Features:
 * - User-friendly error messages for visitors
 * - Simple recovery options (go home, try again)
 * - Minimal technical details (preserve professional image)
 *
 * This boundary is nested within the root error boundary,
 * so it will catch errors first for public routes.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect } from 'react';
import { AlertTriangle, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { logger } from '@/lib/logging';

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log error with structured logger
    logger.error('Public route error boundary triggered', error, {
      boundaryName: 'PublicError',
      errorType: 'boundary',
      digest: error.digest,
    });

    // TODO: Send to error tracking service (implemented in Day 4)
    // trackError(error, {
    //   tags: { boundary: 'public' },
    //   extra: { digest: error.digest }
    // });
  }, [error]);

  return (
    <div className="flex min-h-[400px] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <CardTitle>Oops! Something went wrong</CardTitle>
          </div>
          <CardDescription>
            We encountered an unexpected error. Please try again or return to the home page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Only show error details in development */}
          {process.env.NODE_ENV === 'development' && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-400">
              <p className="font-semibold">Error:</p>
              <p className="font-mono">{error.message}</p>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={reset} className="flex-1">
              Try again
            </Button>
            <Button
              onClick={() => (window.location.href = '/')}
              variant="outline"
              className="flex-1"
            >
              <Home className="mr-2 h-4 w-4" />
              Go home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
