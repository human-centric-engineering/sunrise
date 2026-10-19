'use client';

/**
 * Public Routes Error Boundary
 *
 * Catches errors that occur within public routes (landing, about, contact, etc.).
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { Home } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function PublicError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.ReactElement {
  return (
    <RouteErrorBoundary
      error={error}
      retry={retry}
      boundaryName="PublicError"
      tag="public"
      title="Oops! Something went wrong"
      description="We encountered an unexpected error. Please try again or return to the home page."
      fallback={{
        label: 'Go home',
        href: '/',
        navigate: 'reload',
        icon: <Home className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
