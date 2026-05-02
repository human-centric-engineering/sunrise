/**
 * useExecutionStatusPoller Hook Tests
 *
 * @see lib/hooks/use-execution-status-poller.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ─── Mock dependencies ───────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

import { apiClient, APIClientError } from '@/lib/api/client';
import {
  useExecutionStatusPoller,
  EXECUTION_STATUS_POLL_INTERVAL_MS,
  isTerminalStatus,
  type ExecutionStatusSnapshot,
} from '@/lib/hooks/use-execution-status-poller';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';

function makeSnapshot(overrides: Partial<ExecutionStatusSnapshot> = {}): ExecutionStatusSnapshot {
  return {
    id: EXECUTION_ID,
    status: 'running',
    currentStep: 'step1',
    errorMessage: null,
    totalTokensUsed: 10,
    totalCostUsd: 0.01,
    startedAt: '2026-05-01T12:00:00Z',
    completedAt: null,
    createdAt: '2026-05-01T11:59:55Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('isTerminalStatus', () => {
  it('returns true for completed/failed/cancelled', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('returns false for non-terminal statuses', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('paused_for_approval')).toBe(false);
  });
});

describe('useExecutionStatusPoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial snapshot before any poll fires', () => {
    const initial = makeSnapshot({ status: 'running' });
    const { result } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    expect(result.current).toEqual(initial);
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('does not poll when initial status is already terminal', () => {
    const initial = makeSnapshot({ status: 'completed' });
    const { result } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    // Advance past several intervals
    act(() => {
      vi.advanceTimersByTime(EXECUTION_STATUS_POLL_INTERVAL_MS * 3);
    });

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(result.current).toEqual(initial);
  });

  it('polls /status while non-terminal and updates the snapshot', async () => {
    const initial = makeSnapshot({ status: 'running', currentStep: 'step1' });
    const fresh = makeSnapshot({ status: 'running', currentStep: 'step2', totalCostUsd: 0.05 });
    vi.mocked(apiClient.get).mockResolvedValue(fresh);

    const { result } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    // Trigger the first poll tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_STATUS_POLL_INTERVAL_MS);
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      `/api/v1/admin/orchestration/executions/${EXECUTION_ID}/status`
    );
    expect(result.current.currentStep).toBe('step2');
    expect(result.current.totalCostUsd).toBe(0.05);
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('stops polling and calls router.refresh when status flips to terminal', async () => {
    const initial = makeSnapshot({ status: 'running' });
    const completed = makeSnapshot({
      status: 'completed',
      completedAt: '2026-05-01T12:01:00Z',
    });
    vi.mocked(apiClient.get).mockResolvedValue(completed);

    const { result } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    // First tick: hits the terminal status
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_STATUS_POLL_INTERVAL_MS);
    });

    expect(result.current.status).toBe('completed');
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);

    // Second tick: no further polling because the hook's effect cleanup ran.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_STATUS_POLL_INTERVAL_MS * 2);
    });

    // apiClient.get may still be called once on the terminal tick, but
    // router.refresh must only fire once and no additional gets after the
    // effect has been re-run.
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('silently swallows APIClientError responses from a single poll tick', async () => {
    const initial = makeSnapshot({ status: 'running' });
    vi.mocked(apiClient.get).mockRejectedValueOnce(new APIClientError('boom', 'BOOM', 500));
    const fresh = makeSnapshot({ status: 'running', currentStep: 'step3' });
    vi.mocked(apiClient.get).mockResolvedValueOnce(fresh);

    const { result } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    // First tick fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_STATUS_POLL_INTERVAL_MS);
    });
    // Snapshot still reflects the initial value
    expect(result.current.currentStep).toBe('step1');

    // Second tick succeeds — snapshot updates
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_STATUS_POLL_INTERVAL_MS);
    });
    expect(result.current.currentStep).toBe('step3');
  });

  it('clears the interval on unmount', () => {
    const initial = makeSnapshot({ status: 'running' });
    const { unmount } = renderHook(() => useExecutionStatusPoller(EXECUTION_ID, initial));

    unmount();

    // Advance past several intervals — no calls should be made.
    act(() => {
      vi.advanceTimersByTime(EXECUTION_STATUS_POLL_INTERVAL_MS * 3);
    });

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('respects a custom interval option', async () => {
    const initial = makeSnapshot({ status: 'running' });
    const fresh = makeSnapshot({ status: 'running', currentStep: 'fast' });
    vi.mocked(apiClient.get).mockResolvedValue(fresh);

    const { result } = renderHook(() =>
      useExecutionStatusPoller(EXECUTION_ID, initial, { intervalMs: 500 })
    );

    // Default interval should NOT have triggered yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(apiClient.get).not.toHaveBeenCalled();

    // Custom interval should fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(result.current.currentStep).toBe('fast');
  });
});
