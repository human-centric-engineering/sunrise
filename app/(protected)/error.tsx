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
import { useTranslations } from 'next-intl';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';
import { authLandingLabel, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export default function ProtectedError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.ReactElement {
  const t = useTranslations('account.error');
  const tNav = useTranslations('layout.nav');
  return (
    <RouteErrorBoundary
      error={error}
      retry={retry}
      boundaryName="ProtectedError"
      tag="protected"
      title={t('title')}
      description={t('description')}
      checkSession
      fallback={{
        label: authLandingLabel(tNav('dashboard')),
        href: AUTH_LANDING_ROUTE,
        icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
