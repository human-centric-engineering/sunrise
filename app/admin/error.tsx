'use client';

/**
 * Admin Routes Error Boundary
 *
 * Catches errors that occur within admin routes.
 * Provides admin-specific recovery options.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { LayoutDashboard } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';
import { authLandingLabel, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.shell');
  const tLayout = useTranslations('layout.nav');
  return (
    <RouteErrorBoundary
      error={error}
      retry={retry}
      boundaryName="AdminError"
      tag="admin"
      title={t('errorTitle')}
      description={t('errorDescription')}
      fallback={{
        label: authLandingLabel(tLayout('dashboard')),
        href: AUTH_LANDING_ROUTE,
        icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
