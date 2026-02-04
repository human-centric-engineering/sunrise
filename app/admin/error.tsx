'use client';

/**
 * Admin Routes Error Boundary
 *
 * Catches errors that occur within admin routes.
 * Provides admin-specific recovery options.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard } from 'lucide-react';
import { ErrorCard } from '@/components/ui/error-card';
import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    logger.error('Admin route error boundary triggered', error, {
      boundaryName: 'AdminError',
      errorType: 'boundary',
      digest: error.digest,
    });

    trackError(error, {
      tags: {
        boundary: 'admin',
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
      title="Admin Error"
      description="An error occurred in the admin panel. This has been logged."
      error={error}
      actions={[
        { label: 'Try again', onClick: reset },
        {
          label: 'Dashboard',
          onClick: () => router.push('/dashboard'),
          variant: 'outline',
          icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
        },
      ]}
    />
  );
}
