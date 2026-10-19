'use client';

/**
 * Shown in place of data a server component could not load.
 *
 * Pairs with `loadServerData()` from `lib/api/server-load.ts`: when a panel's
 * load returns `ok: false`, render this where the panel would be, so the admin
 * sees that something failed rather than an empty list. "Try again" calls
 * `router.refresh()`, which re-runs the page's server fetches.
 *
 * For the data a page exists to show, use `requireServerData()` instead and
 * let the route's error boundary handle it.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface LoadFailedNoticeProps {
  /** What failed to load, as a noun phrase: "recent executions", "providers". */
  what: string;
  className?: string;
}

export function LoadFailedNotice({ what, className }: LoadFailedNoticeProps): React.ReactElement {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();

  return (
    <div
      role="alert"
      className={cn(
        'border-destructive/40 bg-destructive/5 flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm',
        className
      )}
    >
      <p className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Couldn&apos;t load {what}. The error has been logged.</span>
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={isRefreshing}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
        {isRefreshing ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  );
}
