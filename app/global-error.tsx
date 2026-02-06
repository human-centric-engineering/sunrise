'use client';

/**
 * Global Error Boundary
 *
 * Catches errors that occur in the root layout or other parts of the
 * application that the root error.tsx cannot catch. This is the final
 * fallback for unhandled errors.
 *
 * IMPORTANT: This component must render its own <html> and <body> tags
 * because it completely replaces the root layout when an error occurs.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error#global-errortsx
 */

import { useEffect } from 'react';
import { AlertTriangle, Home, RotateCcw } from 'lucide-react';
import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error('Global error boundary triggered', error, {
      boundaryName: 'GlobalError',
      errorType: 'boundary',
      digest: error.digest,
    });

    trackError(error, {
      tags: {
        boundary: 'global',
        errorType: 'boundary',
      },
      extra: {
        digest: error.digest,
        componentStack: 'global',
      },
      level: ErrorSeverity.Fatal,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-gray-50 dark:bg-gray-900">
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-lg dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="h-6 w-6" />
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Application Error
              </h1>
            </div>

            <p className="mt-4 text-gray-600 dark:text-gray-400">
              A critical error occurred. This has been logged and we&apos;ll look into it.
            </p>

            {/* Dev-only error details */}
            {process.env.NODE_ENV === 'development' && (
              <div className="mt-4 space-y-2">
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

            <div className="mt-6 flex gap-3">
              <button
                onClick={reset}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
              >
                <RotateCcw className="h-4 w-4" />
                Try again
              </button>
              <button
                onClick={() => (window.location.href = '/')}
                className="flex flex-1 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <Home className="h-4 w-4" />
                Go home
              </button>
            </div>

            {process.env.NODE_ENV === 'production' && (
              <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
                If this problem persists, please{' '}
                <a
                  href="/contact"
                  className="underline hover:text-gray-900 dark:hover:text-gray-200"
                >
                  contact support
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
