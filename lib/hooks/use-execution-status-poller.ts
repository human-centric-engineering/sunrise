'use client';

/**
 * useExecutionStatusPoller
 *
 * Polls `GET /api/v1/admin/orchestration/executions/:id/status` while the
 * execution is in a non-terminal status (`pending`, `running`, or
 * `paused_for_approval`). Returns the latest status snapshot so the detail
 * view can render live status, current step, cost, and tokens without a
 * full page reload.
 *
 * When the status flips to a terminal value (`completed`, `failed`,
 * `cancelled`), polling stops and `router.refresh()` is invoked so the
 * server-rendered trace catches up to the new terminal state.
 *
 * The lightweight `/status` endpoint is intentionally narrow (no trace,
 * no input/output) so this poll is cheap to run on every active
 * execution detail page.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const EXECUTION_STATUS_POLL_INTERVAL_MS = 3_000;

export interface ExecutionStatusSnapshot {
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

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function useExecutionStatusPoller(
  executionId: string,
  initial: ExecutionStatusSnapshot,
  options?: { intervalMs?: number }
): ExecutionStatusSnapshot {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<ExecutionStatusSnapshot>(initial);
  const intervalMs = options?.intervalMs ?? EXECUTION_STATUS_POLL_INTERVAL_MS;

  useEffect(() => {
    // Effect re-runs when status changes (idiomatic — clears the interval and
    // either starts a new one for the next non-terminal status, or early-exits
    // once terminal).
    if (isTerminalStatus(snapshot.status)) return;

    let cancelled = false;
    let alreadyRefreshed = false;

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const fresh = await apiClient.get<ExecutionStatusSnapshot>(
          API.ADMIN.ORCHESTRATION.executionStatus(executionId)
        );
        if (cancelled) return;
        setSnapshot(fresh);
        if (isTerminalStatus(fresh.status) && !alreadyRefreshed) {
          alreadyRefreshed = true;
          // Refresh the server component so the trace catches up.
          router.refresh();
        }
      } catch (err) {
        // Non-critical: on transient network or 401/403, the next tick will
        // retry. We only swallow APIClientError-shaped failures — anything
        // else propagates so a real bug isn't silently masked.
        if (!(err instanceof APIClientError)) throw err;
      }
    };

    const intervalId = setInterval(() => void poll(), intervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [executionId, intervalMs, router, snapshot.status]);

  return snapshot;
}
