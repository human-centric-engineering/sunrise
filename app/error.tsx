'use client';

/**
 * Root Error Boundary
 *
 * Catches all unhandled errors in the application that aren't caught
 * by more specific error boundaries.
 *
 * This is a Next.js convention file that must be a client component.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect } from 'react';
import { AlertTriangle, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log error with structured logger
    logger.error('Root error boundary triggered', error, {
      boundaryName: 'RootError',
      errorType: 'boundary',
      digest: error.digest,
    });

    // Send to error tracking service
    trackError(error, {
      tags: {
        boundary: 'root',
        errorType: 'boundary',
      },
      extra: {
        digest: error.digest,
        componentStack: 'root',
      },
      level: ErrorSeverity.Error,
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An unexpected error occurred. This has been logged and we&apos;ll look into it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Show error details in development */}
          {process.env.NODE_ENV === 'development' && (
            <div className="space-y-2">
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-400">
                <p className="font-semibold">Error:</p>
                <p className="font-mono">{error.message}</p>
              </div>
              {error.digest && (
                <div className="rounded-md bg-gray-100 p-3 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  <p className="font-semibold">Error Digest:</p>
                  <p className="font-mono">{error.digest}</p>
                </div>
              )}
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

          {/* Support link for production */}
          {process.env.NODE_ENV === 'production' && (
            <p className="text-center text-sm text-gray-600 dark:text-gray-400">
              If this problem persists, please{' '}
              <a href="/contact" className="underline hover:text-gray-900 dark:hover:text-gray-200">
                contact support
              </a>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
