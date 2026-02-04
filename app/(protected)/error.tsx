'use client';

/**
 * Protected Routes Error Boundary
 *
 * Catches errors that occur within protected routes (dashboard, settings, profile).
 * Detects session expiration and redirects to login.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { logger } from '@/lib/logging';
import { authClient } from '@/lib/auth/client';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [isSessionExpired, setIsSessionExpired] = useState(false);

  useEffect(() => {
    logger.error('Protected route error boundary triggered', error, {
      boundaryName: 'ProtectedError',
      errorType: 'boundary',
      digest: error.digest,
    });

    const checkSession = async (): Promise<void> => {
      try {
        const session = await authClient.getSession();
        if (!session) {
          setIsSessionExpired(true);
          logger.warn('Session expired in protected route', {
            boundaryName: 'ProtectedError',
          });
        }
      } catch {
        setIsSessionExpired(true);
      }
    };

    void checkSession();

    trackError(error, {
      tags: {
        boundary: 'protected',
        errorType: 'boundary',
      },
      extra: {
        digest: error.digest,
        isSessionExpired: isSessionExpired.toString(),
      },
      level: ErrorSeverity.Error,
    });
  }, [error, isSessionExpired]);

  // Session expired — show login prompt (unique to protected routes)
  if (isSessionExpired) {
    return (
      <div className="flex min-h-[400px] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <LogIn className="h-5 w-5 text-blue-500" />
              <CardTitle>Session Expired</CardTitle>
            </div>
            <CardDescription>
              Your session has expired. Please sign in again to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push('/login')} className="w-full">
              Sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <ErrorCard
      title="Something went wrong"
      description="An error occurred while loading this page. This has been logged."
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
