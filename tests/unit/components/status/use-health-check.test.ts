// @vitest-environment happy-dom

/**
 * Tests: useHealthCheck hook
 *
 * Covers the hook's observable contract: what it puts into state, when it fires
 * `onStatusChange`, how polling is governed, and the PR #268 safety net — that
 * a malformed `/api/health` payload becomes a clean `error` state rather than a
 * silent `undefined` in the UI.
 *
 * @see components/status/use-health-check.ts
 * @see lib/validations/monitoring.ts (healthCheckResponseSchema)
 * @see tests/unit/lib/validations/monitoring.test.ts (schema-only tests)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHealthCheck } from '@/components/status/use-health-check';
import type { HealthCheckResponse } from '@/lib/monitoring';

// ─── Shared fixtures ─────────────────────────────────────────────────────────
// Mirrors the validPayload shape used in tests/unit/lib/validations/monitoring.test.ts

const validOkPayload: HealthCheckResponse = {
  status: 'ok',
  version: '1.0.0',
  sunrise: '0.1.0',
  uptime: 1234,
  timestamp: '2026-05-28T10:00:00.000Z',
  services: {
    database: {
      status: 'operational',
      connected: true,
      latency: 5,
    },
  },
};

const validErrorPayload: HealthCheckResponse = {
  status: 'error',
  version: '1.0.0',
  sunrise: '0.1.0',
  uptime: 1234,
  timestamp: '2026-05-28T10:00:00.000Z',
  services: {
    database: {
      status: 'outage',
      connected: false,
    },
  },
  error: 'Database unreachable',
};

// Malformed payload: missing the `sunrise` field — the schema added in PR #268
// will reject this, triggering the parse-failure path in fetchHealth.
const malformedPayload = {
  status: 'ok',
  version: '1.0.0',
  // sunrise omitted deliberately
  uptime: 1234,
  timestamp: '2026-05-28T10:00:00.000Z',
  services: {
    database: { status: 'operational', connected: true, latency: 5 },
  },
};

// Polling cadence shared across most polling-lifecycle and status-change tests.
// Tests that need to compare two different cadences (e.g. the re-render
// reschedule test) declare their own local constants.
const POLLING_INTERVAL_MS = 5000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetchOnce(payload: unknown, status = 200): void {
  vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status })
  );
}

function mockFetchOnceRejected(reason: unknown): void {
  vi.spyOn(global, 'fetch').mockRejectedValueOnce(reason);
}

// Queues a fetch that won't settle until the caller invokes resolve() or reject().
// Use for tests that need to observe in-flight state (refresh isLoading, unmount
// mid-flight, etc.).
function mockFetchOncePending(): {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
} {
  let resolveFn!: (r: Response) => void;
  let rejectFn!: (e: unknown) => void;
  vi.spyOn(global, 'fetch').mockReturnValueOnce(
    new Promise<Response>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    })
  );
  return { resolve: resolveFn, reject: rejectFn };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('useHealthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Initial fetch + auto-start ─────────────────────────────────────────────

  describe('initial fetch + auto-start', () => {
    it('populates data, clears isLoading, and sets lastUpdated on a successful first fetch', async () => {
      mockFetchOnce(validOkPayload);

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      // isLoading starts true before the first fetch resolves
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toMatchObject({ status: 'ok', sunrise: '0.1.0' });
      // lastUpdated is set by the hook after a successful parse — it's not in the payload
      expect(result.current.lastUpdated).toBeInstanceOf(Date);
      expect(result.current.error).toBeNull();
    });

    it('does NOT fire onStatusChange on the first successful fetch', async () => {
      // previousStatus starts as null; the guard requires it to be non-null
      // AND different from the new status before firing. On the very first fetch
      // the null check prevents the callback from running.
      mockFetchOnce(validOkPayload);
      const onStatusChange = vi.fn();

      await act(async () => {
        renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('does not start a polling interval when autoStart is false', async () => {
      mockFetchOnce(validOkPayload);
      // No further mocks set up — any extra fetch would throw/fail the test

      renderHook(() => useHealthCheck({ autoStart: false, pollingInterval: POLLING_INTERVAL_MS }));

      await act(async () => {
        // Advance past two full polling cycles
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 2 + 100);
      });

      // Only the single initial fetch ran
      expect(global.fetch).toHaveBeenCalledTimes(1);
      // Finding #6: removed the decorative isPolling === false assertion here;
      // the hook initialises isPolling: autoStart, so it's trivially false from t=0
      // regardless of polling behaviour. The fetch-count check above is load-bearing.
    });

    it('calls fetch with the custom endpoint URL when endpoint option is provided', async () => {
      // Finding #3: without this test a regression that hardcodes '/api/health'
      // would pass every other test while silently ignoring the endpoint option.
      const customEndpoint = '/custom/health';
      mockFetchOnce(validOkPayload);

      renderHook(() => useHealthCheck({ autoStart: false, endpoint: customEndpoint }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(global.fetch).toHaveBeenCalledWith(customEndpoint);
    });
  });

  // ── Parse-failure path (PR #268 safety net) ───────────────────────────────

  describe('parse-failure path', () => {
    it('sets an error whose message starts with "Invalid /api/health response shape:" when the payload fails schema validation', async () => {
      // A payload missing `sunrise` passes json() but fails healthCheckResponseSchema.safeParse().
      // The hook must throw with the prefixed message — not silently render undefined.
      mockFetchOnce(malformedPayload);

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toMatch(/^Invalid \/api\/health response shape:/);
      expect(result.current.isLoading).toBe(false);
    });

    it('fires onStatusChange("error") on the first parse failure', async () => {
      // The error path fires onStatusChange whenever previousStatus !== 'error'.
      // On the first call previousStatus is null, so the callback runs — this is
      // the asymmetric behaviour relative to the success-path first-fetch guard.
      mockFetchOnce(malformedPayload);
      const onStatusChange = vi.fn();

      await act(async () => {
        renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith('error');
    });

    it('preserves the previous data when a subsequent fetch fails schema validation', async () => {
      // Sequence: good fetch (seeds data) → bad fetch (parse fails).
      // The error path only updates isLoading and error — it must NOT wipe data.
      mockFetchOnce(validOkPayload); // first fetch: succeeds
      mockFetchOnce(malformedPayload); // second fetch: parse fails

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      // First fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.data?.status).toBe('ok');

      // Finding #7: capture lastUpdated after the first successful fetch.
      // After the error path, the hook must spread the previous state rather than
      // constructing a fresh object — same Date instance proves the spread ran.
      const firstLastUpdated = result.current.lastUpdated;
      expect(firstLastUpdated).toBeInstanceOf(Date);

      // Manually trigger a second fetch using refresh()
      await act(async () => {
        await result.current.refresh();
      });

      // data must still be the good payload; the parse failure must not wipe it
      expect(result.current.data).toMatchObject({ status: 'ok', sunrise: '0.1.0' });
      expect(result.current.error?.message).toMatch(/^Invalid \/api\/health response shape:/);
      // Same Date instance: proves the error-path spread preserved lastUpdated
      expect(result.current.lastUpdated).toBe(firstLastUpdated);
    });
  });

  // ── Fetch-error path ───────────────────────────────────────────────────────

  describe('fetch-error path', () => {
    it('preserves the thrown Error instance on result.current.error', async () => {
      const networkError = new Error('Network unreachable');
      mockFetchOnceRejected(networkError);

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // The hook re-uses the original Error instance (err instanceof Error branch)
      expect(result.current.error).toBe(networkError);
      expect(result.current.isLoading).toBe(false);
    });

    it('wraps a non-Error thrown value as new Error("Failed to fetch health status")', async () => {
      // Covers the fallback branch: `err instanceof Error ? err : new Error('Failed to fetch health status')`
      mockFetchOnceRejected('string error');

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Failed to fetch health status');
    });

    it('fires onStatusChange("error") on the first fetch failure', async () => {
      // Asymmetric with the success path: the first ERROR does fire onStatusChange
      // because previousStatus starts as null, and the error guard only checks
      // `previousStatus.current !== 'error'` (null !== 'error' is true).
      mockFetchOnceRejected(new Error('down'));
      const onStatusChange = vi.fn();

      await act(async () => {
        renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith('error');
    });
  });

  // ── Status-change detection ────────────────────────────────────────────────

  describe('status-change detection', () => {
    it('fires onStatusChange("error") exactly once on an ok → error transition', async () => {
      mockFetchOnce(validOkPayload); // seeds previousStatus = 'ok'
      mockFetchOnce(validErrorPayload); // triggers transition

      const onStatusChange = vi.fn();

      const { result } = renderHook(() =>
        useHealthCheck({
          autoStart: false,
          pollingInterval: POLLING_INTERVAL_MS,
          onStatusChange,
        })
      );

      // First fetch: seeds status, no callback
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onStatusChange).not.toHaveBeenCalled();

      // Second fetch via refresh: ok → error transition
      await act(async () => {
        await result.current.refresh();
      });

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith('error');
    });

    it('fires onStatusChange("ok") exactly once on an error → ok transition', async () => {
      mockFetchOnceRejected(new Error('down')); // seeds 'error'
      mockFetchOnce(validOkPayload); // triggers error → ok transition

      const onStatusChange = vi.fn();

      const { result } = renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));

      // First fetch: error, fires onStatusChange('error')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      onStatusChange.mockClear();

      // Second fetch: error → ok transition
      await act(async () => {
        await result.current.refresh();
      });

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith('ok');
    });

    it('does NOT fire onStatusChange when the same status is repeated across fetches', async () => {
      mockFetchOnce(validOkPayload); // seeds 'ok'
      mockFetchOnce(validOkPayload); // same status — no transition

      const onStatusChange = vi.fn();

      const { result } = renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onStatusChange).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.refresh();
      });

      // Still not called — ok → ok is not a transition
      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('calls the LATEST onStatusChange when re-rendered with a new callback before the transition fires', async () => {
      // Finding #5: verifies the ref-update useEffect (hook lines 97-102).
      // Re-renders with a new callback must update onStatusChangeRef.current so the
      // NEXT status change fires the new callback, not the original one.
      mockFetchOnce(validOkPayload); // first fetch: seeds previousStatus = 'ok'
      mockFetchOnce(validErrorPayload); // second fetch: ok → error transition

      const firstCallback = vi.fn();
      const secondCallback = vi.fn();

      const { result, rerender } = renderHook(
        ({ cb }: { cb: (status: 'ok' | 'error') => void }) =>
          useHealthCheck({ autoStart: false, onStatusChange: cb }),
        { initialProps: { cb: firstCallback } }
      );

      // First fetch: seeds previousStatus = 'ok', no callback fires (first-fetch guard)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(firstCallback).not.toHaveBeenCalled();

      // Re-render with the new callback — onStatusChangeRef.current is updated
      rerender({ cb: secondCallback });

      // Trigger the ok → error transition
      await act(async () => {
        await result.current.refresh();
      });

      // The NEW callback must fire; the original one must NOT
      expect(secondCallback).toHaveBeenCalledTimes(1);
      expect(secondCallback).toHaveBeenCalledWith('error');
      expect(firstCallback).not.toHaveBeenCalled();
    });
  });

  // ── Polling lifecycle ──────────────────────────────────────────────────────

  describe('polling lifecycle', () => {
    it('startPolling() refreshes immediately and then every interval', async () => {
      // Initial fetch + the refresh on resume + 2 polling ticks = 4 total.
      // The immediate refresh is deliberate: "Resume" on the status page should
      // show fresh data rather than waiting out a full interval.
      for (let i = 0; i < 4; i++) mockFetchOnce(validOkPayload);

      const { result } = renderHook(() =>
        useHealthCheck({ autoStart: false, pollingInterval: POLLING_INTERVAL_MS })
      );

      // Initial fetch — `autoStart: false` must still populate the UI once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.startPolling();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 2);
      });

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(result.current.isPolling).toBe(true);
    });

    it('calling startPolling while already polling is a no-op — no double-fetch per tick', async () => {
      for (let i = 0; i < 4; i++) mockFetchOnce(validOkPayload);

      const { result } = renderHook(() =>
        useHealthCheck({ autoStart: false, pollingInterval: POLLING_INTERVAL_MS })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      act(() => {
        result.current.startPolling();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(2); // initial + resume refresh

      // Halfway through the interval, ask to start again. Polling is already on,
      // so nothing re-arms: no extra fetch, and the running interval keeps its
      // original phase rather than being pushed out.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS / 2);
      });
      act(() => {
        result.current.startPolling();
      });

      expect(result.current.isPolling).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // The remaining half of the ORIGINAL interval fires exactly one tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS / 2);
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('stopPolling stops further fetches and flips isPolling to false', async () => {
      for (let i = 0; i < 2; i++) mockFetchOnce(validOkPayload);

      const { result } = renderHook(() =>
        useHealthCheck({ autoStart: false, pollingInterval: POLLING_INTERVAL_MS })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      act(() => {
        result.current.startPolling();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.isPolling).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2); // initial + resume refresh

      act(() => {
        result.current.stopPolling();
      });
      expect(result.current.isPolling).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('pauses while the tab is hidden and refreshes when it comes back (#442)', async () => {
      // /api/health runs SELECT 1, so an unattended background tab used to keep
      // a scale-to-zero database awake by itself — 2,880 queries a day.
      for (let i = 0; i < 4; i++) mockFetchOnce(validOkPayload);

      renderHook(() => useHealthCheck({ pollingInterval: POLLING_INTERVAL_MS }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Back in the foreground: refresh at once, then resume the cadence.
      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);

      hidden.mockRestore();
    });

    it('unmount clears the polling interval — no further fetches after the component unmounts', async () => {
      mockFetchOnce(validOkPayload);
      // If the interval leaked after unmount, a second fetch would run at t=INTERVAL.

      const { unmount } = renderHook(() =>
        useHealthCheck({ autoStart: true, pollingInterval: POLLING_INTERVAL_MS })
      );

      // Let the initial fetch settle
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      unmount();

      // Advance well past the next polling tick
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 2);
      });

      // Still only the single pre-unmount fetch
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('re-renders with a shorter pollingInterval reschedules ticks at the new cadence', async () => {
      // Finding #4: the useEffect deps include [fetchHealth, autoStart, pollingInterval].
      // Changing pollingInterval re-runs the effect: re-fetches AND reschedules the
      // interval with the new value. A regression that ignored the dep change would
      // continue ticking at INTERVAL_A even after the rerender.
      const INTERVAL_A = 10000;
      const INTERVAL_B = 5000;

      // Effect re-runs on the rerender, triggering another initFetch + new interval.
      // That means: 1 initial fetch + 1 re-render fetch + 1 tick at INTERVAL_B = 3 total.
      mockFetchOnce(validOkPayload); // initial fetch (INTERVAL_A effect)
      mockFetchOnce(validOkPayload); // re-render initFetch (INTERVAL_B effect)
      mockFetchOnce(validOkPayload); // first tick at INTERVAL_B

      const { rerender } = renderHook(
        ({ interval }: { interval: number }) =>
          useHealthCheck({ autoStart: true, pollingInterval: interval }),
        { initialProps: { interval: INTERVAL_A } }
      );

      // Initial fetch from INTERVAL_A effect
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Re-render with INTERVAL_B before INTERVAL_A elapses.
      // The effect re-runs: re-fetches + starts a new interval at INTERVAL_B.
      rerender({ interval: INTERVAL_B });

      // Flush the re-render initFetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Advance INTERVAL_B — one tick should fire at the new cadence.
      // If the old INTERVAL_A interval were still active it would NOT fire yet
      // (only INTERVAL_B of INTERVAL_A elapsed). Seeing a third fetch proves
      // the scheduler switched to INTERVAL_B.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL_B);
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  // ── Refresh + mounted guard ────────────────────────────────────────────────

  describe('refresh + mounted guard', () => {
    it('sets isLoading: true before refetching when refresh() is called', async () => {
      mockFetchOnce(validOkPayload); // initial fetch
      // For the refresh() call: hold the fetch pending so we can observe the
      // intermediate isLoading: true state before the promise resolves.
      const { resolve: resolveRefresh } = mockFetchOncePending();

      const { result } = renderHook(() => useHealthCheck({ autoStart: false }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.isLoading).toBe(false);

      // Finding #8: capture lastUpdated after the initial fetch.
      // Fake timers freeze new Date() at the same value — the check is for a NEW
      // Date OBJECT, not a later timestamp, proving the success-path setState ran.
      const initialLastUpdated = result.current.lastUpdated;
      expect(initialLastUpdated).toBeInstanceOf(Date);

      // Kick off refresh without awaiting — capture the intermediate state
      let refreshPromise!: Promise<void>;
      act(() => {
        refreshPromise = result.current.refresh();
      });

      // refresh() sets isLoading: true synchronously before the fetch resolves
      expect(result.current.isLoading).toBe(true);

      // Resolve the pending fetch and await refresh
      await act(async () => {
        resolveRefresh(new Response(JSON.stringify(validOkPayload)));
        await refreshPromise;
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toMatchObject({ status: 'ok' });
      // A new Date instance was constructed — proves the success-path setState ran.
      // Object identity differs even though fake timers return the same time value.
      expect(result.current.lastUpdated).toBeInstanceOf(Date);
      expect(result.current.lastUpdated).not.toBe(initialLastUpdated);
    });

    it('does not fire onStatusChange via the success path after the component unmounts', async () => {
      // Findings #1 + #2 (Test A — success-path guard replacement):
      // The previous test only verified React 18+'s built-in silent setState drop on
      // unmount — not the hook's own mountedRef guard. This test uses onStatusChange
      // as the observable because it sits INSIDE the guarded code path (hook line 122):
      //   if (!mountedRef.current) return;   ← guard
      //   if (...) onStatusChangeRef.current(data.status);  ← only reachable with guard intact
      // If the guard is removed, resolving the held promise fires onStatusChange.
      // With the guard intact, the callback must NOT fire after unmount.

      // Seed previousStatus = 'ok' via a first successful fetch
      mockFetchOnce(validOkPayload);

      // Hold a second fetch pending — it will be dispatched by refresh()
      const { resolve: resolveSecondFetch } = mockFetchOncePending();

      const onStatusChange = vi.fn();
      const { result, unmount } = renderHook(() =>
        useHealthCheck({ autoStart: false, onStatusChange })
      );

      // First fetch: seeds previousStatus = 'ok', no callback (first-fetch guard)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onStatusChange).not.toHaveBeenCalled();

      // Dispatch second fetch (ok → error transition pending)
      act(() => {
        void result.current.refresh();
      });

      // Unmount BEFORE resolving — sets mountedRef.current = false
      unmount();

      // Clear any calls from before unmount (there should be none, but be defensive)
      onStatusChange.mockClear();

      // Resolve with a payload that would trigger ok → error callback.
      // Without the guard, this fires onStatusChange('error'). With the guard: silent.
      await act(async () => {
        resolveSecondFetch(new Response(JSON.stringify(validErrorPayload)));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('does not fire onStatusChange via the catch path after the component unmounts', async () => {
      // Findings #1 + #2 (Test B — catch-path guard replacement):
      // onStatusChange is the observable because it also sits INSIDE the catch-path
      // guard (hook line 142):
      //   if (!mountedRef.current) return;   ← guard
      //   if (...) onStatusChangeRef.current('error');  ← only reachable with guard intact
      // On the first fetch previousStatus is null, so the error-path check
      // (null !== 'error') would fire the callback if the guard were absent.
      // With the guard intact, the callback must NOT fire after unmount.

      // Hold the initial fetch promise so we can unmount before it rejects
      const { reject: rejectFetch } = mockFetchOncePending();

      const onStatusChange = vi.fn();
      const { unmount } = renderHook(() => useHealthCheck({ autoStart: false, onStatusChange }));

      // Kick off the initial fetch (in flight; not yet resolved)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Unmount before the promise rejects — sets mountedRef.current = false
      unmount();

      // Reject the fetch after unmount.
      // Without the catch-path guard this fires onStatusChange('error') because
      // previousStatus is null and null !== 'error'. With the guard: silent.
      await act(async () => {
        rejectFetch(new Error('network failure'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });
});
