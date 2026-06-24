/**
 * useCopyToClipboard Hook Tests
 *
 * Covers the happy path (copy → copied flips true → resets after the delay),
 * the configurable delay, the clipboard-failure path, and — the reason this
 * hook exists (issue #301) — that the pending reset timer is cleared on unmount
 * and re-armed (not stacked) on a rapid second copy, so it never fires setState
 * on an unmounted component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';

describe('useCopyToClipboard', () => {
  // happy-dom exposes a real clipboard behind a non-writable getter, so spy on
  // the prototype's writeText rather than reassigning navigator.clipboard.
  let writeTextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeTextSpy.mockRestore();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('starts with copied=false', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    expect(result.current.copied).toBe(false);
  });

  it('writes the text, flips copied=true, and resolves true', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.copy('hello');
    });

    expect(returned).toBe(true);
    expect(writeTextSpy).toHaveBeenCalledWith('hello');
    expect(result.current.copied).toBe(true);
  });

  it('resets copied=false after the default 2000ms', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('x');
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('honours a custom reset delay', async () => {
    const { result } = renderHook(() => useCopyToClipboard(1500));

    await act(async () => {
      await result.current.copy('x');
    });

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('clears the pending reset timer on unmount (issue #301)', async () => {
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('x');
    });
    // The reset is now armed and pending.
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    // Unmount cleanup must clear it — otherwise it would fire setState on the
    // unmounted hook (~2s later, throwing after the test env tears down).
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms rather than stacks the timer on a rapid second copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('first');
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    await act(async () => {
      await result.current.copy('second');
    });
    // The first timer was cleared before arming the second — only one pending.
    expect(vi.getTimerCount()).toBe(1);

    // The first copy's would-be reset (at t=2000) must NOT flip copied back;
    // the re-armed timer runs to the second copy's full delay.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copied).toBe(false);
  });

  it('swallows clipboard failure: resolves false, copied stays false, no timer armed', async () => {
    writeTextSpy.mockRejectedValueOnce(new Error('NotAllowedError'));
    const { result } = renderHook(() => useCopyToClipboard());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.copy('x');
    });

    expect(returned).toBe(false);
    expect(result.current.copied).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
