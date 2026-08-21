// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useTimeout } from '@/lib/hooks/use-timeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTimeout', () => {
  it('runs the callback after the delay', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useTimeout());

    act(() => result.current(callback, 1000));
    expect(callback).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not run the callback after unmount', () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useTimeout());

    act(() => result.current(callback, 1000));
    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('leaves no pending timer behind on unmount', () => {
    // The property #597 is actually about. A callback that never fires is the
    // symptom; a timer still queued when the environment is torn down is the
    // cause, and it is what fails a run with no failing test.
    const { result, unmount } = renderHook(() => useTimeout());

    act(() => result.current(vi.fn(), 3000));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels every pending timer, not just the most recent', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, unmount } = renderHook(() => useTimeout());

    act(() => {
      result.current(first, 1000);
      result.current(second, 2000);
    });
    expect(vi.getTimerCount()).toBe(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('stops a callback that reschedules itself', () => {
    // The approval-card poll shape: each run queues the next. Cancelling the
    // one pending timer has to break the chain, or unmount leaks a poll that
    // runs for ever.
    const { result, unmount } = renderHook(() => useTimeout());
    const tick = vi.fn(() => result.current(() => tick(), 100));

    act(() => result.current(() => tick(), 100));
    act(() => {
      vi.advanceTimersByTime(350);
    });
    // Fires at 100/200/300 — asserted as "the chain is genuinely recursing"
    // rather than a hardcoded count, so the test survives a delay change.
    const callsWhileMounted = tick.mock.calls.length;
    expect(callsWhileMounted).toBeGreaterThanOrEqual(3);

    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(tick).toHaveBeenCalledTimes(callsWhileMounted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets a timer once it has fired, so the set does not grow unbounded', () => {
    // Asserted through `clearTimeout` rather than `getTimerCount()`: a fired
    // timer leaves the count at 0 whether or not the hook drops its id, and
    // `clearTimeout` tolerates a stale id, so the obvious version of this test
    // passes with the bookkeeping deleted. Watching *what unmount clears* is
    // what actually pins it.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = renderHook(() => useTimeout());

    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    act(() => result.current(vi.fn(), 100));
    const firedId: unknown = setSpy.mock.results[0]?.value;

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(vi.getTimerCount()).toBe(0);

    clearSpy.mockClear();
    unmount();

    // The id is gone from the set, so unmount has nothing to clear.
    expect(clearSpy.mock.calls.map((call) => call[0])).not.toContain(firedId);
  });

  it('ignores a schedule() issued after unmount', () => {
    // Almost every call site schedules from the continuation of an `await`, so
    // a component unmounted mid-request lands here. Before this was handled the
    // timer went into a set the (already-run) cleanup would never drain again —
    // an uncancellable timer, from the hook whose whole job is preventing them.
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useTimeout());

    unmount();
    act(() => result.current(callback, 3000));

    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('returns a stable reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useTimeout());
    const first = result.current;

    rerender();
    expect(result.current).toBe(first);
  });
});
