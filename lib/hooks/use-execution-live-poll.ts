'use client';

/**
 * useExecutionLivePoll
 *
 * Polls `GET /api/v1/admin/orchestration/executions/:id/live` at a fast
 * cadence (default 1s) while the execution is non-terminal, returning the
 * full live payload — snapshot, persisted trace, cost entries, and the
 * running-step details — so the detail view's UI is fully driven from
 * client state during a run.
 *
 * Behaviour:
 *   - Polls every `intervalMs` while non-terminal.
 *   - Pauses when `document.hidden`; resumes on visibilitychange with an
 *     immediate poll, then continues at the configured interval.
 *   - Exponential backoff on `APIClientError` (cap 30s) so a stalled
 *     server doesn't cause a hot retry loop. Resets to base on success.
 *   - On the terminal transition fires one final poll, then calls
 *     `router.refresh()` so any server-rendered surfaces (e.g. the
 *     page's RSC fetch) catch up, then stops.
 *   - Cleans up on unmount.
 *
 * The hook is deliberately stateful — it owns the trace once it has
 * polled once. The caller seeds it from the server's initial fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { ExecutionTraceEntry } from '@/types/orchestration';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const EXECUTION_LIVE_POLL_INTERVAL_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface ExecutionLiveSnapshot {
  id: string;
  status: string;
  currentStep: string | null;
  errorMessage: string | null;
  totalTokensUsed: number;
  totalCostUsd: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CurrentStepDetails {
  stepId: string;
  label: string;
  stepType: string;
  startedAt: string;
}

export interface ExecutionLiveCostEntry {
  stepId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  operation: string;
  createdAt: string;
}

export interface ExecutionLivePayload {
  snapshot: ExecutionLiveSnapshot;
  trace: ExecutionTraceEntry[];
  costEntries: ExecutionLiveCostEntry[];
  currentStepDetails: CurrentStepDetails | null;
}

export interface UseExecutionLivePollResult extends ExecutionLivePayload {
  /** True while the hook is actively polling (non-terminal status). */
  isPolling: boolean;
  /** Last APIClientError caught, if any — surfaces a transient banner. */
  lastError: APIClientError | null;
}

export function useExecutionLivePoll(
  executionId: string,
  initial: ExecutionLivePayload,
  options?: { intervalMs?: number }
): UseExecutionLivePollResult {
  const router = useRouter();
  const baseInterval = options?.intervalMs ?? EXECUTION_LIVE_POLL_INTERVAL_MS;

  const [payload, setPayload] = useState<ExecutionLivePayload>(initial);
  const [lastError, setLastError] = useState<APIClientError | null>(null);

  // Refs survive renders without re-triggering the effect.
  const errorCountRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalisedRef = useRef(false);

  const status = payload.snapshot.status;
  const terminal = isTerminalStatus(status);

  const clearScheduledPoll = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (terminal) {
      // If we entered the terminal state this render and haven't yet fired the
      // final reconcile fetch, do it now: one more `/live` to pick up any
      // step_completed write that landed between ticks, then nudge the
      // server-rendered page so anything not in the live payload (e.g. the
      // workflow name) reflects the terminal state.
      if (!finalisedRef.current) {
        finalisedRef.current = true;
        let cancelled = false;
        void (async () => {
          try {
            const fresh = await apiClient.get<ExecutionLivePayload>(
              API.ADMIN.ORCHESTRATION.executionLive(executionId)
            );
            if (!cancelled) setPayload(fresh);
          } catch (err) {
            if (!(err instanceof APIClientError)) throw err;
          } finally {
            if (!cancelled) router.refresh();
          }
        })();
        return () => {
          cancelled = true;
        };
      }
      return;
    }

    // Non-terminal: schedule a polling loop. Re-runs when status (terminal-ness)
    // changes or interval changes; the recursive setTimeout self-schedules.
    let cancelled = false;

    const computeDelay = (): number => {
      const errs = errorCountRef.current;
      if (errs === 0) return baseInterval;
      const backoff = baseInterval * 2 ** errs;
      return Math.min(BACKOFF_CAP_MS, backoff);
    };

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      // The 'use client' directive guarantees `document` is defined; the
      // hidden check is the only branch that needs to read it.
      if (document.hidden) {
        // Tab is hidden; do nothing. visibilitychange will re-schedule us.
        return;
      }
      try {
        const fresh = await apiClient.get<ExecutionLivePayload>(
          API.ADMIN.ORCHESTRATION.executionLive(executionId)
        );
        if (cancelled) return;
        errorCountRef.current = 0;
        setLastError(null);
        setPayload(fresh);
      } catch (err) {
        if (err instanceof APIClientError) {
          errorCountRef.current += 1;
          setLastError(err);
        } else {
          // Propagate unknown errors so real bugs surface.
          throw err;
        }
      } finally {
        if (!cancelled && !isTerminalStatus(payload.snapshot.status)) {
          // Schedule next tick relative to the *completion* of this one, not
          // a fixed wall-clock cadence — avoids backing-up on a slow server.
          timeoutRef.current = setTimeout(() => void poll(), computeDelay());
        }
      }
    };

    timeoutRef.current = setTimeout(() => void poll(), baseInterval);

    const onVisibilityChange = (): void => {
      if (cancelled) return;
      if (document.hidden) {
        // Pause — cancel the next scheduled poll. We'll re-fire on visible.
        clearScheduledPoll();
      } else {
        // Resume — immediate poll, then the .finally() inside poll() restarts
        // the timer at baseInterval.
        clearScheduledPoll();
        void poll();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearScheduledPoll();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // `payload.snapshot.status` drives the terminal-ness re-evaluation so the
    // effect re-runs when the status transitions. The other refs survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId, baseInterval, terminal, payload.snapshot.status]);

  return {
    ...payload,
    isPolling: !terminal,
    lastError,
  };
}
