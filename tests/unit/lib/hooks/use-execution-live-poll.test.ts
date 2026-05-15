/**
 * useExecutionLivePoll Hook Tests
 *
 * @see lib/hooks/use-execution-live-poll.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
  useExecutionLivePoll,
  EXECUTION_LIVE_POLL_INTERVAL_MS,
  isTerminalStatus,
  type ExecutionLivePayload,
} from '@/lib/hooks/use-execution-live-poll';

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';

function makePayload(overrides: Partial<ExecutionLivePayload> = {}): ExecutionLivePayload {
  return {
    snapshot: {
      id: EXECUTION_ID,
      status: 'running',
      currentStep: 'step-1',
      errorMessage: null,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      startedAt: '2026-05-01T12:00:00Z',
      completedAt: null,
      createdAt: '2026-05-01T11:59:55Z',
    },
    trace: [],
    costEntries: [],
    currentStepDetails: {
      stepId: 'step-1',
      label: 'Load models',
      stepType: 'llm_call',
      startedAt: '2026-05-01T12:00:01Z',
    },
    ...overrides,
  };
}

describe('isTerminalStatus', () => {
  it('classifies terminal vs non-terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('paused_for_approval')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
  });
});

describe('useExecutionLivePoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Visibility defaults to visible.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial payload before any poll fires', () => {
    const initial = makePayload();
    const { result } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    expect(result.current.snapshot).toEqual(initial.snapshot);
    expect(result.current.currentStepDetails).toEqual(initial.currentStepDetails);
    expect(result.current.isPolling).toBe(true);
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('fires exactly one final reconcile fetch + router.refresh when initial status is already terminal', async () => {
    const initial = makePayload({
      snapshot: { ...makePayload().snapshot, status: 'completed' },
      currentStepDetails: null,
    });
    vi.mocked(apiClient.get).mockResolvedValue(initial);

    const { result } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    // Let the finalise effect run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.isPolling).toBe(false);

    // No further polls fire after the finalise.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS * 3);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('polls /live while non-terminal and updates payload', async () => {
    const initial = makePayload();
    const fresh = makePayload({
      snapshot: { ...initial.snapshot, currentStep: 'step-2', totalCostUsd: 0.05 },
      currentStepDetails: {
        stepId: 'step-2',
        label: 'Analyse',
        stepType: 'llm_call',
        startedAt: '2026-05-01T12:00:10Z',
      },
    });
    vi.mocked(apiClient.get).mockResolvedValue(fresh);

    const { result } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS);
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      `/api/v1/admin/orchestration/executions/${EXECUTION_ID}/live`
    );
    expect(result.current.snapshot.currentStep).toBe('step-2');
    expect(result.current.snapshot.totalCostUsd).toBe(0.05);
    expect(result.current.currentStepDetails?.stepId).toBe('step-2');
  });

  it('fires final reconcile fetch + router.refresh on terminal transition', async () => {
    const initial = makePayload();
    const completed = makePayload({
      snapshot: {
        ...initial.snapshot,
        status: 'completed',
        completedAt: '2026-05-01T12:01:00Z',
      },
      currentStepDetails: null,
    });
    vi.mocked(apiClient.get).mockResolvedValue(completed);

    const { result } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    // First tick fetches the terminal-state payload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS);
    });
    expect(result.current.snapshot.status).toBe('completed');

    // The terminal-transition finalise effect re-runs and fetches once more,
    // then refreshes the router.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.isPolling).toBe(false);
  });

  it('backs off exponentially on APIClientError, then resets on success', async () => {
    const initial = makePayload();
    vi.mocked(apiClient.get).mockRejectedValueOnce(new APIClientError('boom', 'BOOM', 500));
    vi.mocked(apiClient.get).mockRejectedValueOnce(new APIClientError('boom', 'BOOM', 500));
    const fresh = makePayload({
      snapshot: { ...initial.snapshot, currentStep: 'step-3' },
    });
    vi.mocked(apiClient.get).mockResolvedValueOnce(fresh);

    const { result } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    // First tick at base interval fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(result.current.lastError).toBeInstanceOf(APIClientError);

    // Next tick should be scheduled at base * 2 = 2s. At 1.5s nothing fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS * 1.5);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // At 2s the second (also failing) poll fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS * 0.5);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(2);

    // After two failures, next delay = base * 4 = 4s. Advance 4s → 3rd poll
    // succeeds, clears lastError.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS * 4);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(3);
    expect(result.current.snapshot.currentStep).toBe('step-3');
    expect(result.current.lastError).toBeNull();
  });

  it('pauses polling when document.hidden becomes true', async () => {
    const initial = makePayload();
    const fresh = makePayload({
      snapshot: { ...initial.snapshot, currentStep: 'step-2' },
    });
    vi.mocked(apiClient.get).mockResolvedValue(fresh);

    renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    // First poll fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // Tab goes hidden — dispatch visibilitychange. The hook clears the pending
    // timer so subsequent intervals do not fire.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS * 3);
    });
    // No new polls while hidden.
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('resumes immediately when document becomes visible again', async () => {
    const initial = makePayload();
    vi.mocked(apiClient.get).mockResolvedValue(initial);

    renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    // First poll fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXECUTION_LIVE_POLL_INTERVAL_MS);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // Hide.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Show — should trigger an immediate poll.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('cleans up the timer on unmount', () => {
    const initial = makePayload();
    const { unmount } = renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial));

    unmount();

    act(() => {
      vi.advanceTimersByTime(EXECUTION_LIVE_POLL_INTERVAL_MS * 3);
    });

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('respects a custom intervalMs', async () => {
    const initial = makePayload();
    vi.mocked(apiClient.get).mockResolvedValue(initial);

    renderHook(() => useExecutionLivePoll(EXECUTION_ID, initial, { intervalMs: 250 }));

    // Default 1s shouldn't have triggered yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(apiClient.get).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});
