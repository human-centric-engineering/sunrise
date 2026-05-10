/**
 * useVoiceRecording — `MediaRecorder` lifecycle hook for the chat surfaces.
 *
 * Owns the browser-side audio capture state machine that the admin and
 * embed mic buttons consume:
 *
 *   idle ── start() ──> requesting ── permission grant ──> recording
 *                       │                                  │
 *                       └── permission denied → error      └── stop()/auto-stop → blob
 *
 * Responsibilities:
 *   - Pick a `MediaRecorder` MIME the browser actually supports (opus
 *     where possible, AAC on Safari, browser default as a last resort).
 *   - Clamp recording duration client-side at `maxDurationMs` so users
 *     don't upload audio that the server's 25 MB cap will reject.
 *   - Track elapsed time so the UI can render a "0:12" indicator.
 *   - Surface `NotAllowedError` (mic disabled) distinctly from generic
 *     failures so the UI can show a permissions-policy hint.
 *   - Tear down the MediaStream tracks on stop / unmount so the
 *     browser drops the recording dot and the mic LED.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Hard cap for client-side recording. Exceeded clips are auto-stopped. */
export const DEFAULT_MAX_DURATION_MS = 180_000;

/** MIME candidates in preference order. */
const PREFERRED_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const;

export type VoiceRecordingState = 'idle' | 'requesting' | 'recording' | 'stopping';

export type VoiceRecordingError =
  | { code: 'unsupported'; message: string }
  | { code: 'permission_denied'; message: string }
  | { code: 'capture_failed'; message: string };

export interface VoiceRecording {
  blob: Blob;
  /** Effective MIME the browser used (codec params included). */
  mimeType: string;
  /** Final wall-clock duration of the recording in ms. */
  durationMs: number;
}

export interface UseVoiceRecordingOptions {
  /** Maximum recording length before client-side auto-stop. Default 180_000 ms. */
  maxDurationMs?: number;
}

export interface UseVoiceRecordingResult {
  /** Current state — drives button label, disabled state, and live region copy. */
  state: VoiceRecordingState;
  /** Elapsed time in ms (only meaningful while `state === 'recording'`). */
  elapsedMs: number;
  /** Last error encountered. Cleared by `start()`. */
  error: VoiceRecordingError | null;
  /** Whether the runtime supports `MediaRecorder` + `getUserMedia`. */
  supported: boolean;
  /** Begin a recording. Resolves when the browser confirms capture has started. */
  start: () => Promise<void>;
  /** Stop the current recording. Resolves with the captured blob, or null on failure. */
  stop: () => Promise<VoiceRecording | null>;
  /** Cancel without yielding a blob — used on unmount and explicit cancel UX. */
  cancel: () => void;
}

function pickSupportedMime(): string {
  if (
    typeof window === 'undefined' ||
    typeof window.MediaRecorder === 'undefined' ||
    typeof window.MediaRecorder.isTypeSupported !== 'function'
  ) {
    return '';
  }
  for (const mime of PREFERRED_MIMES) {
    if (window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.MediaRecorder === 'undefined') return false;
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    return false;
  }
  return true;
}

export function useVoiceRecording(options: UseVoiceRecordingOptions = {}): UseVoiceRecordingResult {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const [state, setState] = useState<VoiceRecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<VoiceRecordingError | null>(null);
  const [supported] = useState<boolean>(() => isSupported());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveStopRef = useRef<((value: VoiceRecording | null) => void) | null>(null);
  const stoppedDurationRef = useRef<number>(0);
  // Tracks whether the consuming component is still mounted. The unmount
  // cleanup flips this to `false`, and `start()` checks it after the
  // `getUserMedia` await — without this, an unmount during the permission
  // prompt would leak the resolved `MediaStream` (cleanup runs while
  // `streamRef.current` is still null, then the late-arriving stream gets
  // assigned and the recorder starts on an orphaned component).
  const isMountedRef = useRef<boolean>(true);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // already inactive — nothing to clean up beyond the stream.
      }
    }
    teardownStream();
    chunksRef.current = [];
    recorderRef.current = null;
    resolveStopRef.current?.(null);
    resolveStopRef.current = null;
    setState('idle');
    setElapsedMs(0);
  }, [teardownStream]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      // Ensure the mic indicator is released when the component unmounts mid-record.
      isMountedRef.current = false;
      teardownStream();
    };
  }, [teardownStream]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setError(null);

    if (!supported) {
      setError({
        code: 'unsupported',
        message: 'Voice input is not supported in this browser',
      });
      return;
    }

    setState('requesting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Real browsers throw DOMException, but happy-dom and some sandboxed
      // iframes surface plain Errors with a `name` property. Accept either.
      const name = err instanceof Error ? err.name : '';
      const code =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'permission_denied'
          : 'capture_failed';
      // Only update React state if the component is still mounted —
      // setState on an unmounted component is a no-op but emits a dev
      // warning. The stream wasn't acquired so there's nothing to clean.
      if (isMountedRef.current) {
        setError({
          code,
          message:
            code === 'permission_denied'
              ? 'Microphone access was blocked. Allow it in your browser settings to record audio.'
              : 'Could not access the microphone. Check that no other app is using it and try again.',
        });
        setState('idle');
      }
      return;
    }

    // Component unmounted while we were awaiting getUserMedia. The cleanup
    // already ran but couldn't tear down a stream that didn't exist yet —
    // we have it now and must release the mic immediately.
    if (!isMountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;
    const mimeType = pickSupportedMime();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
      teardownStream();
      setError({
        code: 'capture_failed',
        message: err instanceof Error ? err.message : 'Recorder could not start',
      });
      setState('idle');
      return;
    }

    chunksRef.current = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const finalBlob = new Blob(chunksRef.current, {
        type: chunksRef.current[0]?.type || mimeType || 'audio/webm',
      });
      teardownStream();
      const captured: VoiceRecording = {
        blob: finalBlob,
        mimeType: chunksRef.current[0]?.type || mimeType || 'audio/webm',
        durationMs: stoppedDurationRef.current,
      };
      resolveStopRef.current?.(finalBlob.size > 0 ? captured : null);
      resolveStopRef.current = null;
      recorderRef.current = null;
      setState('idle');
      setElapsedMs(0);
    });
    recorder.addEventListener('error', () => {
      setError({ code: 'capture_failed', message: 'Recorder reported an error' });
      cancel();
    });

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start();

    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);

    autoStopRef.current = setTimeout(() => {
      void stop();
    }, maxDurationMs);

    setState('recording');
    // `stop` is referenced above before declaration via the auto-stop closure;
    // guarded by the `recording` state check inside it, so there's no race.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, supported, teardownStream, cancel, maxDurationMs]);

  const stop = useCallback(async (): Promise<VoiceRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setState('idle');
      return null;
    }

    setState('stopping');
    stoppedDurationRef.current = Date.now() - startedAtRef.current;
    return new Promise<VoiceRecording | null>((resolve) => {
      resolveStopRef.current = resolve;
      try {
        recorder.stop();
      } catch (err) {
        setError({
          code: 'capture_failed',
          message: err instanceof Error ? err.message : 'Recorder failed to stop',
        });
        teardownStream();
        resolve(null);
        resolveStopRef.current = null;
        setState('idle');
      }
    });
  }, [teardownStream]);

  return {
    state,
    elapsedMs,
    error,
    supported,
    start,
    stop,
    cancel,
  };
}
