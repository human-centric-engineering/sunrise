'use client';

/**
 * Protected Routes Error Boundary
 *
 * Catches errors that occur within protected routes (dashboard, settings, profile).
 * Features:
 * - Session expiration detection → redirect to login
 * - User-friendly error messages for authenticated users
 * - Context-aware recovery options
 *
 * This boundary is nested within the root error boundary,
 * so it will catch errors first for protected routes.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, LogIn, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
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
    // Log error with structured logger
    logger.error('Protected route error boundary triggered', error, {
      boundaryName: 'ProtectedError',
      errorType: 'boundary',
      digest: error.digest,
    });

    // Check if this is a session expiration error
    const checkSession = async () => {
      try {
        const session = await authClient.getSession();
        if (!session) {
          setIsSessionExpired(true);
          logger.warn('Session expired in protected route', {
            boundaryName: 'ProtectedError',
          });
        }
      } catch {
        // If we can't check session, assume it's expired
        setIsSessionExpired(true);
      }
    };

    void checkSession();

    // Send to error tracking service
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

  // If session expired, show login prompt
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

  // Otherwise show standard error UI
  return (
    <div className="flex min-h-[400px] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An error occurred while loading this page. This has been logged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Show error details in development */}
          {process.env.NODE_ENV === 'development' && (
            <div className="space-y-2">
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

          <div className="flex gap-2">
            <Button onClick={reset} className="flex-1">
              Try again
            </Button>
            <Button onClick={() => router.push('/dashboard')} variant="outline" className="flex-1">
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
