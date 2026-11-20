'use client';

/**
 * Root Error Boundary
 *
 * Catches all unhandled errors in the application that aren't caught
 * by more specific error boundaries.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { Home } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.ReactElement {
  const t = useTranslations('errors');
  return (
    <RouteErrorBoundary
      error={error}
      retry={retry}
      boundaryName="RootError"
      tag="root"
      title={t('generic.title')}
      description={t('generic.description')}
      extra={{ componentStack: 'root' }}
      containerClassName="min-h-screen"
      fallback={{
        label: t('generic.goHome'),
        href: '/',
        navigate: 'reload',
        icon: <Home className="mr-2 h-4 w-4" />,
      }}
      footer={
        process.env.NODE_ENV === 'production' ? (
          <p className="text-center text-sm text-gray-600 dark:text-gray-400">
            {t.rich('root.contactSupport', {
              link: (chunks) => (
                <a
                  href="/contact"
                  className="underline hover:text-gray-900 dark:hover:text-gray-200"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
        ) : undefined
      }
    />
  );
}
