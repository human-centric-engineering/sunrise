/**
 * useVoiceRecording — hook unit tests.
 *
 * Covers:
 * - Reports `supported: false` when MediaRecorder/getUserMedia are missing
 * - `start()` requests mic access, transitions through states, picks an opus MIME
 * - `start()` then `stop()` resolves with the captured blob and mimeType
 * - Permission denial surfaces a `permission_denied` error
 * - `cancel()` aborts mid-record and tears down the stream
 * - `unmount` releases the stream
 *
 * Uses module-level mocks of `MediaRecorder` and `navigator.mediaDevices.getUserMedia`
 * to keep happy-dom-compatible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// `PREFERRED_MIMES` drives `MockRecorder.isTypeSupported` below; importing
// it here keeps the mock's support set aligned with the source list. The
// hook itself has no module-side effects that would interfere with mocks
// being installed first.
import { PREFERRED_MIMES, useVoiceRecording } from '@/lib/hooks/use-voice-recording';

// ---------------------------------------------------------------------------
// Mock MediaRecorder + getUserMedia on the global before importing the hook
// ---------------------------------------------------------------------------

const stopMock = vi.fn();
const startMock = vi.fn();
/**
 * Most-recently-constructed recorder. Tests that need to fire the
 * `error` event (the `capture_failed` regression) reach into this
 * reference rather than monkey-patching, mirroring how a real browser
 * fires events on the live recorder instance.
 */
let latestRecorder: MockRecorder | null = null;

class MockRecorder {
  public state: 'inactive' | 'recording' | 'paused' = 'inactive';
  public mimeType: string;
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    // Tracking the most-recent instance lets tests fire events on the live
    // recorder without monkey-patching the prototype. `this` is required
    // here — eslint's no-this-alias is over-eager for this idiom.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestRecorder = this;
  }

  addEventListener(event: string, cb: (event?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  removeEventListener(): void {
    /* not used in these tests */
  }

  start(): void {
    this.state = 'recording';
    startMock();
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    stopMock();
    // Simulate the browser firing 'dataavailable' then 'stop'.
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType });
    this.fire('dataavailable', { data: blob });
    this.fire('stop');
  }

  /** Test helper to simulate a mid-record error. */
  simulateError(): void {
    this.fire('error');
  }

  fire(event: string, payload?: unknown): void {
    const list = this.listeners.get(event) ?? [];
    list.forEach((cb) => cb(payload));
  }
}

// Drive `isTypeSupported` from the source's canonical `PREFERRED_MIMES`
// list. Adding or reordering a MIME in the source automatically extends
// the mock's support set so tests don't fall behind.
(MockRecorder as unknown as { isTypeSupported: (mime: string) => boolean }).isTypeSupported = (
  mime: string
) => (PREFERRED_MIMES as readonly string[]).includes(mime);

const stopTrackMock = vi.fn();
const getUserMediaMock = vi.fn();

beforeEach(() => {
  stopMock.mockReset();
  startMock.mockReset();
  stopTrackMock.mockReset();
  getUserMediaMock.mockReset();
  latestRecorder = null;
  getUserMediaMock.mockResolvedValue({
    getTracks: () => [{ stop: stopTrackMock }],
  } as unknown as MediaStream);
  // @ts-expect-error attaching to global for the hook to pick up
  globalThis.MediaRecorder = MockRecorder;
  // @ts-expect-error happy-dom doesn't expose mediaDevices by default
  navigator.mediaDevices = { getUserMedia: getUserMediaMock };
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error reset
  globalThis.MediaRecorder = undefined;
});

// `useVoiceRecording` and `PREFERRED_MIMES` are imported at the top of the
// file (before the MediaRecorder mock setup) so the mock's `isTypeSupported`
// can derive its support set from the canonical list.

describe('useVoiceRecording', () => {
  it('reports supported when MediaRecorder + getUserMedia are present', () => {
    const { result } = renderHook(() => useVoiceRecording());
    expect(result.current.supported).toBe(true);
  });

  it('reports unsupported and surfaces an error on start() when MediaRecorder is missing', async () => {
    // @ts-expect-error remove MediaRecorder for this test
    globalThis.MediaRecorder = undefined;
    const { result } = renderHook(() => useVoiceRecording());

    expect(result.current.supported).toBe(false);

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error?.code).toBe('unsupported');
  });

  it('transitions idle → recording on start()', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('recording');
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
  });

  it('captures a blob with the picked mimeType on stop()', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    let captured: { blob: Blob; mimeType: string; durationMs: number } | null = null;
    await act(async () => {
      captured = (await result.current.stop()) ?? null;
    });

    expect(captured).not.toBeNull();
    const c = captured as unknown as { blob: Blob; mimeType: string; durationMs: number };
    expect(c.mimeType).toMatch(/^audio\/webm/);
    expect(c.blob.size).toBeGreaterThan(0);
    expect(stopTrackMock).toHaveBeenCalled();
  });

  it('surfaces NotAllowedError as permission_denied', async () => {
    getUserMediaMock.mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    );
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('surfaces SecurityError as permission_denied (cross-origin / permissions-policy block)', async () => {
    // SecurityError fires when the calling document is not in a secure
    // context, or when the parent's Permissions-Policy denies the
    // microphone. The hook maps it to the same `permission_denied` code
    // as NotAllowedError because the user-facing remedy is identical.
    getUserMediaMock.mockRejectedValueOnce(
      Object.assign(new Error('blocked by permissions policy'), { name: 'SecurityError' })
    );
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('surfaces NotFoundError (no microphone) as capture_failed', async () => {
    // Distinguishes hardware-absent failures from permission denials —
    // the user can grant permission, but no software remedy adds a mic.
    getUserMediaMock.mockRejectedValueOnce(
      Object.assign(new Error('no microphone'), { name: 'NotFoundError' })
    );
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('capture_failed');
  });

  it('surfaces capture_failed when the MediaRecorder constructor throws', async () => {
    // Some browsers reject MediaRecorder construction on unusual codec /
    // stream-shape combinations even after `getUserMedia` succeeds. The
    // hook must release the stream tracks (no orphaned mic) and surface
    // a useful error.
    const OriginalRecorder = (globalThis as { MediaRecorder?: typeof MediaRecorder })
      .MediaRecorder!;
    class ThrowingRecorder {
      static isTypeSupported = (
        OriginalRecorder as unknown as { isTypeSupported: (m: string) => boolean }
      ).isTypeSupported;
      constructor() {
        throw new Error('codec rejected by recorder');
      }
    }
    // @ts-expect-error swap in the throwing recorder for this test only
    globalThis.MediaRecorder = ThrowingRecorder;

    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('capture_failed');
    // Stream tracks must be torn down even though recording never started —
    // otherwise the mic indicator stays on with no path to release it.
    expect(stopTrackMock).toHaveBeenCalled();

    // Restore for downstream tests.
    globalThis.MediaRecorder = OriginalRecorder;
  });

  it('cancel() stops the recorder and tears down the stream', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('recording');

    await act(async () => {
      result.current.cancel();
    });

    expect(result.current.state).toBe('idle');
    expect(stopTrackMock).toHaveBeenCalled();
  });

  it('auto-stops when maxDurationMs elapses', async () => {
    const { result } = renderHook(() => useVoiceRecording({ maxDurationMs: 100 }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('recording');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });

    expect(stopMock).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('elapsedMs increments while recording', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  // ── Race-condition coverage ─────────────────────────────────────────────────

  it('stop() before start() resolves to null and stays idle', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    let captured: unknown = 'unset';
    await act(async () => {
      captured = await result.current.stop();
    });

    expect(captured).toBeNull();
    expect(result.current.state).toBe('idle');
    expect(stopTrackMock).not.toHaveBeenCalled();
  });

  it('cancel() before start() is a safe no-op', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      result.current.cancel();
    });

    expect(result.current.state).toBe('idle');
    expect(stopTrackMock).not.toHaveBeenCalled();
  });

  it('start() while already recording is a no-op (does not request mic twice)', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.start();
    });

    // Still only one getUserMedia call — second start() short-circuits on the
    // state guard. Without this, a double-click would open a second mic stream
    // and leak the first.
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it('recorder error event surfaces capture_failed and tears down the stream', async () => {
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    expect(latestRecorder).not.toBeNull();

    // Fire the actual `error` event on the recorder — exercises the source's
    // `recorder.addEventListener('error', ...)` handler. Without this, the
    // test was passing on a `cancel()` shortcut that bypassed the error
    // handler entirely.
    await act(async () => {
      latestRecorder!.simulateError();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('capture_failed');
    expect(stopTrackMock).toHaveBeenCalled();
  });

  it('unmount during recording stops the MediaStream tracks', async () => {
    const { result, unmount } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });
    expect(stopTrackMock).not.toHaveBeenCalled();

    unmount();

    expect(stopTrackMock).toHaveBeenCalled();
  });

  it('passes mimeType="" when no PREFERRED_MIMES candidate is supported', async () => {
    // A browser that has MediaRecorder but doesn't support any of the
    // preferred codecs falls through to the empty-string fallback in
    // pickSupportedMime — passed as undefined options to the recorder
    // constructor, letting the browser pick its own default.
    const original = (MockRecorder as unknown as { isTypeSupported: (m: string) => boolean })
      .isTypeSupported;
    (MockRecorder as unknown as { isTypeSupported: (m: string) => boolean }).isTypeSupported = () =>
      false;

    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });

    // Hook proceeds without an explicit mimeType. The MockRecorder default
    // ('audio/webm') still applies for the captured-blob assertion.
    expect(result.current.state).toBe('recording');
    expect(latestRecorder?.mimeType).toBe('audio/webm');

    // Restore.
    (MockRecorder as unknown as { isTypeSupported: (m: string) => boolean }).isTypeSupported =
      original;
  });

  it('surfaces capture_failed when recorder.stop() throws synchronously', async () => {
    // The MediaRecorder spec allows `.stop()` to throw on unusual states
    // (e.g. recorder ended unexpectedly). The hook must drop into the
    // catch path: surface `capture_failed`, tear down the stream, and
    // resolve the in-flight stop promise with null so the caller knows
    // the recording didn't yield a blob.
    const { result } = renderHook(() => useVoiceRecording());

    await act(async () => {
      await result.current.start();
    });
    expect(latestRecorder).not.toBeNull();

    // Override the mock recorder's stop to throw — the catch block at
    // use-voice-recording.ts:288-299 is the regression target.
    const throwOnStop = (): void => {
      throw new Error('recorder ended unexpectedly');
    };
    Object.defineProperty(latestRecorder!, 'stop', {
      value: throwOnStop,
      configurable: true,
    });

    let captured: { blob: Blob; mimeType: string; durationMs: number } | null = null;
    await act(async () => {
      captured = (await result.current.stop()) ?? null;
    });

    expect(captured).toBeNull();
    expect(result.current.state).toBe('idle');
    expect(result.current.error?.code).toBe('capture_failed');
    expect(stopTrackMock).toHaveBeenCalled();
  });

  it('unmount mid-getUserMedia stops the late-arriving MediaStream and never starts the recorder', async () => {
    // Regression for the leak: if the component unmounts while
    // `getUserMedia` is pending, the cleanup runs while `streamRef` is
    // still null. Without the `isMountedRef` guard, the resolved stream
    // would be assigned to a ref on an orphaned component and a recorder
    // would start with no way to stop it — leaking the mic.
    let resolveGum: ((stream: MediaStream) => void) | null = null;
    getUserMediaMock.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGum = resolve;
        })
    );

    const { result, unmount } = renderHook(() => useVoiceRecording());

    // Begin start() — it awaits getUserMedia which is pending.
    let startPromise: Promise<void> | null = null;
    act(() => {
      startPromise = result.current.start();
    });

    // Unmount before the permission prompt resolves.
    unmount();

    // Now resolve getUserMedia with a fresh stream — the hook must
    // release it because the component is gone.
    await act(async () => {
      resolveGum!({
        getTracks: () => [{ stop: stopTrackMock }],
      } as unknown as MediaStream);
      await startPromise;
    });

    // Stream tracks released (single call from the mid-getUserMedia
    // teardown — there's no mounted state machine to walk).
    expect(stopTrackMock).toHaveBeenCalled();
    // Recorder never starts on an unmounted component.
    expect(startMock).not.toHaveBeenCalled();
  });
});
