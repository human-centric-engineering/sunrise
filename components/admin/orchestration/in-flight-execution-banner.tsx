'use client';

/**
 * InFlightExecutionBanner — compact peek banner that surfaces a
 * background orchestration run across every page in the admin
 * orchestration area.
 *
 * Lifecycle:
 *   - Listens to localStorage under
 *     `sunrise.orchestration.in-flight-execution.v1`.
 *   - When set, fetches an initial status snapshot once (mount), then
 *     hands off to `useExecutionStatusPoller` (3 s cadence — peripheral
 *     vision tolerates more latency than the modal's 1 s).
 *   - On terminal status: brief 5 s success/failure flash, then auto-
 *     dismisses and clears localStorage.
 *   - Manual dismiss-X clears localStorage but does NOT cancel the
 *     server-side run.
 *   - On 404 (execution not found / cross-user lookup) clears the
 *     stale entry and exits silently.
 *
 * The banner is intentionally read-only — no approve/reject controls
 * are wired here. Operators returning to the run for action open the
 * full detail page via the click-through link.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronRight, Loader2, X, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import {
  useExecutionStatusPoller,
  isTerminalStatus,
  type ExecutionStatusSnapshot,
} from '@/lib/hooks/use-execution-status-poller';
import {
  IN_FLIGHT_EXECUTION_STORAGE_KEY,
  type InFlightExecutionRef,
} from '@/lib/orchestration/in-flight-execution';
import { formatStatus } from '@/lib/utils/format-status';
import { logger } from '@/lib/logging';

const TERMINAL_FLASH_MS = 5_000;

export function InFlightExecutionBanner(): ReactElement | null {
  const [ref, , clearRef] = useLocalStorage<InFlightExecutionRef | null>(
    IN_FLIGHT_EXECUTION_STORAGE_KEY,
    null
  );

  if (!ref) return null;

  return <BannerForRef key={ref.executionId} entry={ref} onClear={clearRef} />;
}

/**
 * The polling part is split into its own component keyed by execution
 * id so that swapping which execution we're watching mid-mount (e.g.
 * the user starts a second audit while the first is still in flight)
 * resets the local snapshot + flash state cleanly.
 */
function BannerForRef({
  entry,
  onClear,
}: {
  entry: InFlightExecutionRef;
  onClear: () => void;
}): ReactElement | null {
  const [seed, setSeed] = useState<ExecutionStatusSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Initial fetch — the polling hook requires a seed, and we don't
  // have one until we ask the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await apiClient.get<ExecutionStatusSnapshot>(
          API.ADMIN.ORCHESTRATION.executionStatus(entry.executionId)
        );
        if (cancelled) return;
        setSeed(fresh);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof APIClientError) {
          // 404 / 401 / 403 — the entry is stale or the user no longer
          // has access. Drop it silently; better than nagging.
          logger.info('in-flight banner: clearing stale localStorage entry', {
            executionId: entry.executionId,
            status: err.status,
          });
          setLoadFailed(true);
          onClear();
        } else {
          throw err;
        }
      }
    })().catch((err) => {
      logger.error('in-flight banner: unexpected fetch error', err);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.executionId, onClear]);

  if (loadFailed || !seed) return null;
  return <BannerInner entry={entry} seed={seed} onClear={onClear} />;
}

function BannerInner({
  entry,
  seed,
  onClear,
}: {
  entry: InFlightExecutionRef;
  seed: ExecutionStatusSnapshot;
  onClear: () => void;
}): ReactElement | null {
  const snapshot = useExecutionStatusPoller(entry.executionId, seed);
  const [autoDismissed, setAutoDismissed] = useState(false);

  // 5 s flash on terminal, then auto-dismiss + clear localStorage. The
  // setTimeout is scoped to a single transition by gating on the
  // already-dismissed flag.
  useEffect(() => {
    if (!isTerminalStatus(snapshot.status)) return;
    if (autoDismissed) return;
    const handle = setTimeout(() => {
      setAutoDismissed(true);
      onClear();
    }, TERMINAL_FLASH_MS);
    return () => clearTimeout(handle);
  }, [snapshot.status, autoDismissed, onClear]);

  const manualDismiss = useCallback(() => {
    setAutoDismissed(true);
    onClear();
  }, [onClear]);

  if (autoDismissed) return null;

  const terminal = isTerminalStatus(snapshot.status);
  const ok = snapshot.status === 'completed';
  const failed = snapshot.status === 'failed' || snapshot.status === 'cancelled';

  return (
    <div
      data-testid="in-flight-execution-banner"
      data-execution-id={entry.executionId}
      data-status={snapshot.status}
      role="status"
      className="bg-card text-card-foreground sticky top-0 z-20 flex items-center gap-2 border-b px-3 py-1.5 text-xs shadow-sm"
    >
      {terminal ? (
        ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
        )
      ) : (
        <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" />
      )}

      <span className="font-medium">{entry.label}</span>
      <Badge
        variant={terminal ? (ok ? 'secondary' : 'destructive') : 'outline'}
        className="text-[10px]"
      >
        {formatStatus(snapshot.status)}
      </Badge>
      {!terminal && snapshot.currentStep && (
        <span className="text-muted-foreground truncate font-mono">{snapshot.currentStep}</span>
      )}
      {terminal && failed && snapshot.errorMessage && (
        <span className="text-muted-foreground max-w-[24rem] truncate">
          {snapshot.errorMessage}
        </span>
      )}

      <Link
        href={`/admin/orchestration/executions/${entry.executionId}`}
        className="text-primary ml-auto inline-flex items-center gap-1 hover:underline"
        data-testid="in-flight-execution-banner-link"
      >
        Open
        <ChevronRight className="h-3 w-3" />
      </Link>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 w-6 px-0"
        onClick={manualDismiss}
        aria-label="Dismiss in-flight banner"
        data-testid="in-flight-execution-banner-dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
