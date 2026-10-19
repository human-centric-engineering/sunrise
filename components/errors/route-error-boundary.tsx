'use client';

/**
 * Route Error Boundary
 *
 * Shared body for every `app/**\/error.tsx` file. Next.js still requires the
 * per-segment file, but the body is a single delegating render — the logging,
 * Sentry reporting, optional session-expiry detection, and fallback UI all live
 * here, so a fork adding a route group writes a ~10-line wrapper instead of a
 * fourth near-identical boundary.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { logger } from '@/lib/logging';
import { authClient } from '@/lib/auth/client';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

export interface RouteErrorFallbackAction {
  /** Button label, e.g. "Dashboard" */
  label: string;
  /** Destination path */
  href: string;
  /** Optional leading icon */
  icon?: ReactNode;
  /**
   * How to navigate (default: `'router'`).
   *
   * - `'router'` — client-side `router.push()`. Correct within a working shell.
   * - `'reload'` — full document load. Correct for root/public boundaries,
   *   where the shell itself may be what broke.
   */
  navigate?: 'router' | 'reload';
}

export interface RouteErrorBoundaryProps {
  /** The error Next.js handed the boundary */
  error: Error & { digest?: string };
  /**
   * The retry callback Next.js handed the boundary. Not `reset`: `reset` only
   * re-renders, so a page whose server data load failed would fail the same
   * way again. `retry` re-fetches the segment first.
   */
  retry: () => void;
  /** Identifies the boundary in logs, e.g. `"AdminError"` */
  boundaryName: string;
  /** Sentry `boundary` tag, e.g. `"admin"` */
  tag: string;
  /** Card title */
  title: string;
  /** Card description */
  description: string;
  /** Secondary action shown next to "Try again" */
  fallback: RouteErrorFallbackAction;
  /**
   * Check whether the session is still valid and, when it is not, show a
   * "Session Expired → Sign in" card instead of the generic error card.
   * Only meaningful behind authentication (default: `false`).
   */
  checkSession?: boolean;
  /** Extra Sentry context merged into `extra` alongside the digest */
  extra?: Record<string, string>;
  /** Container min-height class, forwarded to `ErrorCard` */
  containerClassName?: string;
  /** Optional footer content, forwarded to `ErrorCard` */
  footer?: ReactNode;
}

export function RouteErrorBoundary({
  error,
  retry,
  boundaryName,
  tag,
  title,
  description,
  fallback,
  checkSession = false,
  extra,
  containerClassName,
  footer,
}: RouteErrorBoundaryProps): React.ReactElement {
  const router = useRouter();
  const [isSessionExpired, setIsSessionExpired] = useState(false);

  // Log and report exactly once per error. `isSessionExpired` is deliberately
  // NOT a dependency: this effect is what sets it, so tracking it would make
  // the effect self-triggering and every session-expiry error would produce two
  // log lines and two Sentry events.
  useEffect(() => {
    logger.error('Route error boundary triggered', error, {
      boundaryName,
      errorType: 'boundary',
      digest: error.digest,
    });

    trackError(error, {
      tags: {
        boundary: tag,
        errorType: 'boundary',
      },
      extra: {
        digest: error.digest,
        ...extra,
      },
      level: ErrorSeverity.Error,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one report per error; see comment above
  }, [error]);

  useEffect(() => {
    if (!checkSession) return;

    const verifySession = async (): Promise<void> => {
      try {
        // better-auth always resolves to a `{ data, error }` envelope — the
        // session itself is `data`. Testing the envelope for truthiness would
        // never fire, so the expiry card would only ever appear on a thrown
        // request.
        const { data: session } = await authClient.getSession();
        if (!session) {
          setIsSessionExpired(true);
          logger.warn('Session expired in error boundary', { boundaryName });
        }
      } catch {
        setIsSessionExpired(true);
      }
    };

    void verifySession();
  }, [checkSession, boundaryName, error]);

  // Session expired — a sign-in prompt is more useful than "try again"
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
      title={title}
      description={description}
      error={error}
      containerClassName={containerClassName}
      actions={[
        { label: 'Try again', onClick: retry },
        {
          label: fallback.label,
          onClick: () => {
            if (fallback.navigate === 'reload') {
              window.location.href = fallback.href;
              return;
            }
            router.push(fallback.href);
          },
          variant: 'outline',
          icon: fallback.icon,
        },
      ]}
      footer={footer}
    />
  );
}
