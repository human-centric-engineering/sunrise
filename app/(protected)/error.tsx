'use client';

/**
 * Protected Routes Error Boundary
 *
 * Catches errors that occur within protected routes (dashboard, settings, profile).
 * Detects session expiration and redirects to login.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { LayoutDashboard } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';
import { AUTH_LANDING_LABEL, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export default function ProtectedError({
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
      boundaryName="ProtectedError"
      tag="protected"
      title="Something went wrong"
      description="An error occurred while loading this page. This has been logged."
      checkSession
      fallback={{
        label: AUTH_LANDING_LABEL,
        href: AUTH_LANDING_ROUTE,
        icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
