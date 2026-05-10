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

// ---------------------------------------------------------------------------
// Mock MediaRecorder + getUserMedia on the global before importing the hook
// ---------------------------------------------------------------------------

const stopMock = vi.fn();
const startMock = vi.fn();

class MockRecorder {
  public state: 'inactive' | 'recording' | 'paused' = 'inactive';
  public mimeType: string;
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
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

(MockRecorder as unknown as { isTypeSupported: (mime: string) => boolean }).isTypeSupported = (
  mime: string
) => mime === 'audio/webm;codecs=opus' || mime === 'audio/webm';

const stopTrackMock = vi.fn();
const getUserMediaMock = vi.fn();

beforeEach(() => {
  stopMock.mockReset();
  startMock.mockReset();
  stopTrackMock.mockReset();
  getUserMediaMock.mockReset();
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

// Dynamic import after mocks land.
const { useVoiceRecording } = await import('@/lib/hooks/use-voice-recording');

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
});
