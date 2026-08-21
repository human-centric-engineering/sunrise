// @vitest-environment happy-dom

/**
 * useAutoRefresh Hook Tests
 *
 * Covers mount-time call, interval ticking, visibility pause/resume,
 * cleanup on unmount, enabled-flag gating, ref-captured latest fn,
 * and swallowing of sync throws + rejected promises.
 *
 * @see lib/hooks/use-auto-refresh.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh';

const INTERVAL = 1000; // 1 s — easy to reason about

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Restore document.hidden to visible. Called in afterEach. */
function restoreVisible(): void {
  Object.defineProperty(document, 'hidden', {
    value: false,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('useAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure tab starts visible for every test.
    restoreVisible();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Always restore visibility so no test contaminates the next.
    restoreVisible();
  });

  // ── 1. Mount call ─────────────────────────────────────────────────────────

  it('calls fn once on mount before any timer advances', () => {
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, INTERVAL));

    // fn was invoked synchronously during the effect's first `run()`.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── 2. Interval ticking ───────────────────────────────────────────────────

  it('calls fn every intervalMs after the mount call', () => {
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, INTERVAL));

    // 1 mount call already happened. Advance 3 full intervals.
    act(() => {
      vi.advanceTimersByTime(INTERVAL * 3);
    });

    // 1 (mount) + 3 (ticks) = 4
    expect(fn).toHaveBeenCalledTimes(4);
  });

  // ── 3. Pause on hidden ────────────────────────────────────────────────────

  it('stops calling fn when document.hidden becomes true', () => {
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, INTERVAL));

    // Advance one tick: mount call + 1 interval = 2 calls.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    // Hide the tab — the interval should be cleared.
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
      writable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Advance several more intervals; fn must not be called again.
    act(() => {
      vi.advanceTimersByTime(INTERVAL * 5);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── 4. Resume on visibility regain ────────────────────────────────────────

  it('calls fn immediately and resumes the interval when tab becomes visible again', () => {
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, INTERVAL));

    // One tick while visible: 2 calls total.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    // Hide.
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
      writable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Still 2 — no new calls while hidden.
    expect(fn).toHaveBeenCalledTimes(2);

    // Show — visibility handler runs run() immediately, then restarts the timer.
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
      writable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Immediate call on regain.
    expect(fn).toHaveBeenCalledTimes(3);

    // Timer is running again — one more tick.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  // ── 5. Cleanup on unmount ─────────────────────────────────────────────────

  it('stops calling fn after unmount', () => {
    const fn = vi.fn();

    const { unmount } = renderHook(() => useAutoRefresh(fn, INTERVAL));

    // One tick: 2 calls.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    unmount();

    // Advance further — no new calls.
    act(() => {
      vi.advanceTimersByTime(INTERVAL * 5);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── 6. enabled: false → no calls ─────────────────────────────────────────

  it('never calls fn when enabled is false', () => {
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, INTERVAL, { enabled: false }));

    act(() => {
      vi.advanceTimersByTime(INTERVAL * 10);
    });

    expect(fn).toHaveBeenCalledTimes(0);
  });

  // ── 7. enabled flip false → true triggers immediate call ─────────────────

  it('calls fn immediately when enabled flips from false to true', () => {
    const fn = vi.fn();
    let enabled = false;

    const { rerender } = renderHook(() => useAutoRefresh(fn, INTERVAL, { enabled }));

    // No call yet.
    expect(fn).toHaveBeenCalledTimes(0);

    // Flip enabled. The effect re-runs because enabled is a dep — run() fires
    // immediately inside the new effect execution.
    enabled = true;
    rerender();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── 8. intervalMs <= 0 → no calls at all ─────────────────────────────────

  it('never calls fn when intervalMs is 0 (effect early-returns before run())', () => {
    // Source line 47: `if (!enabled || intervalMs <= 0) return;`
    // The early-return happens before the mount-time run() at line 89,
    // so even the on-mount call is skipped.
    const fn = vi.fn();

    renderHook(() => useAutoRefresh(fn, 0));

    act(() => {
      vi.advanceTimersByTime(INTERVAL * 10);
    });

    expect(fn).toHaveBeenCalledTimes(0);
  });

  // ── 9. Uses the latest fn (ref pattern) ──────────────────────────────────

  it('invokes the most recent fn closure on interval ticks, not the stale one from mount', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    let currentFn = fn1;

    const { rerender } = renderHook(() => useAutoRefresh(currentFn, INTERVAL));

    // Mount call went to fn1.
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(0);

    // Swap to fn2 via rerender — only the fn ref is updated, not the interval.
    currentFn = fn2;
    rerender();

    // Advance one interval tick — the setInterval callback reads fnRef.current
    // which is now fn2.
    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });

    // fn1 got the mount call; fn2 gets the tick.
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  // ── 10. Sync throw does not crash ─────────────────────────────────────────

  it('swallows synchronous throws from fn without crashing the hook', () => {
    const throwing = (): void => {
      throw new Error('sync boom');
    };

    // renderHook itself must not throw.
    const { unmount } = renderHook(() => useAutoRefresh(throwing, INTERVAL));

    // Advance a few ticks — each fires throwing(), each is swallowed.
    act(() => {
      vi.advanceTimersByTime(INTERVAL * 3);
    });

    // If we reach here the hook did not crash. Clean up.
    unmount();
  });

  // ── 11. Rejected promise does not crash ────────────────────────────────────

  it('swallows rejected promises from async fn without crashing the hook', async () => {
    const asyncThrowing = async (): Promise<void> => {
      throw new Error('async boom');
    };

    const { unmount } = renderHook(() => useAutoRefresh(asyncThrowing, INTERVAL));

    // Drain pending microtasks from the mount-time call plus a couple of ticks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    });

    // If we reach here, the rejection was caught and swallowed by the hook.
    unmount();
  });
});
