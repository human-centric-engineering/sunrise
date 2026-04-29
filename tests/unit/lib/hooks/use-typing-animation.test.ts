/**
 * useTypingAnimation Hook Tests
 *
 * Tests the rAF-based typing animation hook that sits between SSE delta
 * arrival and rendered text.
 *
 * Features tested:
 * - appendDelta buffers text and animates via rAF
 * - flush reveals all remaining text immediately
 * - reset clears everything
 * - disabled mode passes through deltas instantly (no buffering)
 * - chunkSize controls characters per tick
 * - isAnimating reflects animation state
 *
 * @see lib/hooks/use-typing-animation.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';

describe('lib/hooks/use-typing-animation', () => {
  let rafCallbacks: Array<() => void>;
  let originalRaf: typeof requestAnimationFrame;
  let originalCaf: typeof cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;

    // Mock rAF to capture callbacks for manual flushing
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        const id = rafCallbacks.length + 1;
        rafCallbacks.push(() => cb(performance.now()));
        return id;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    vi.restoreAllMocks();
  });

  /** Drain all pending rAF callbacks (simulates browser animation frames). */
  function drainRaf(): void {
    let safety = 100;
    while (rafCallbacks.length > 0 && safety-- > 0) {
      const cbs = [...rafCallbacks];
      rafCallbacks = [];
      for (const cb of cbs) cb();
    }
  }

  it('starts with empty displayText and isAnimating false', () => {
    const { result } = renderHook(() => useTypingAnimation());

    expect(result.current.displayText).toBe('');
    expect(result.current.isAnimating).toBe(false);
  });

  it('appendDelta buffers text and animates it via rAF', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 3 }));

    act(() => {
      result.current.appendDelta('Hello world');
    });

    // isAnimating should be true after appendDelta
    expect(result.current.isAnimating).toBe(true);

    // After draining rAF frames, the full text should be revealed
    act(() => {
      drainRaf();
    });

    expect(result.current.displayText).toBe('Hello world');
    expect(result.current.isAnimating).toBe(false);
  });

  it('respects chunkSize — reveals N characters per tick', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 2 }));

    act(() => {
      result.current.appendDelta('ABCDEF');
    });

    // Drain one rAF tick at a time
    act(() => {
      const cb = rafCallbacks.shift();
      cb?.();
    });

    // After first tick: 2 chars revealed
    expect(result.current.displayText).toBe('AB');

    act(() => {
      const cb = rafCallbacks.shift();
      cb?.();
    });

    // After second tick: 4 chars
    expect(result.current.displayText).toBe('ABCD');

    act(() => {
      const cb = rafCallbacks.shift();
      cb?.();
    });

    // After third tick: all 6 chars
    expect(result.current.displayText).toBe('ABCDEF');
    expect(result.current.isAnimating).toBe(false);
  });

  it('flush reveals all remaining text immediately', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 1 }));

    act(() => {
      result.current.appendDelta('Hello world');
    });

    // Only drain one tick — partial reveal
    act(() => {
      const cb = rafCallbacks.shift();
      cb?.();
    });

    expect(result.current.displayText).toBe('H');

    // Flush should reveal everything
    act(() => {
      result.current.flush();
    });

    expect(result.current.displayText).toBe('Hello world');
    expect(result.current.isAnimating).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('reset clears all state', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 3 }));

    act(() => {
      result.current.appendDelta('Hello');
    });

    act(() => {
      drainRaf();
    });

    expect(result.current.displayText).toBe('Hello');

    act(() => {
      result.current.reset();
    });

    expect(result.current.displayText).toBe('');
    expect(result.current.isAnimating).toBe(false);
  });

  it('disabled mode passes through deltas instantly', () => {
    const { result } = renderHook(() => useTypingAnimation({ disabled: true }));

    act(() => {
      result.current.appendDelta('Instant');
    });

    // No rAF needed — text is immediately available
    expect(result.current.displayText).toBe('Instant');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('disabled mode accumulates multiple deltas', () => {
    const { result } = renderHook(() => useTypingAnimation({ disabled: true }));

    act(() => {
      result.current.appendDelta('A');
      result.current.appendDelta('B');
      result.current.appendDelta('C');
    });

    expect(result.current.displayText).toBe('ABC');
  });

  it('handles multiple appendDelta calls with animation', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 5 }));

    act(() => {
      result.current.appendDelta('Hello');
      result.current.appendDelta(' world');
    });

    act(() => {
      drainRaf();
    });

    expect(result.current.displayText).toBe('Hello world');
  });

  it('reset during animation cancels pending frames', () => {
    const { result } = renderHook(() => useTypingAnimation({ chunkSize: 1 }));

    act(() => {
      result.current.appendDelta('ABCDEF');
    });

    // Drain one tick
    act(() => {
      const cb = rafCallbacks.shift();
      cb?.();
    });

    expect(result.current.displayText).toBe('A');

    act(() => {
      result.current.reset();
    });

    expect(result.current.displayText).toBe('');
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('flush on empty state is a no-op', () => {
    const { result } = renderHook(() => useTypingAnimation());

    act(() => {
      result.current.flush();
    });

    expect(result.current.displayText).toBe('');
    expect(result.current.isAnimating).toBe(false);
  });

  it('reset on empty state is a no-op', () => {
    const { result } = renderHook(() => useTypingAnimation());

    act(() => {
      result.current.reset();
    });

    expect(result.current.displayText).toBe('');
    expect(result.current.isAnimating).toBe(false);
  });
});
