'use client';

/**
 * Public Routes Error Boundary
 *
 * Catches errors that occur within public routes (landing, about, contact, etc.).
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect } from 'react';
import { Home } from 'lucide-react';
import { ErrorCard } from '@/components/ui/error-card';
import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error('Public route error boundary triggered', error, {
      boundaryName: 'PublicError',
      errorType: 'boundary',
      digest: error.digest,
    });

    trackError(error, {
      tags: {
        boundary: 'public',
        errorType: 'boundary',
      },
      extra: {
        digest: error.digest,
      },
      level: ErrorSeverity.Error,
    });
  }, [error]);

  return (
    <ErrorCard
      title="Oops! Something went wrong"
      description="We encountered an unexpected error. Please try again or return to the home page."
      error={error}
      actions={[
        { label: 'Try again', onClick: reset },
        {
          label: 'Go home',
          onClick: () => (window.location.href = '/'),
          variant: 'outline',
          icon: <Home className="mr-2 h-4 w-4" />,
        },
      ]}
    />
  );
}
