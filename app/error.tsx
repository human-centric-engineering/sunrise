'use client';

/**
 * Root Error Boundary
 *
 * Catches all unhandled errors in the application that aren't caught
 * by more specific error boundaries.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect } from 'react';
import { Home } from 'lucide-react';
import { ErrorCard } from '@/components/ui/error-card';
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
    logger.error('Root error boundary triggered', error, {
      boundaryName: 'RootError',
      errorType: 'boundary',
      digest: error.digest,
    });

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
    <ErrorCard
      title="Something went wrong"
      description="An unexpected error occurred. This has been logged and we'll look into it."
      error={error}
      containerClassName="min-h-screen"
      actions={[
        { label: 'Try again', onClick: reset },
        {
          label: 'Go home',
          onClick: () => (window.location.href = '/'),
          variant: 'outline',
          icon: <Home className="mr-2 h-4 w-4" />,
        },
      ]}
      footer={
        process.env.NODE_ENV === 'production' ? (
          <p className="text-center text-sm text-gray-600 dark:text-gray-400">
            If this problem persists, please{' '}
            <a href="/contact" className="underline hover:text-gray-900 dark:hover:text-gray-200">
              contact support
            </a>
            .
          </p>
        ) : undefined
      }
    />
  );
}
