'use client';

/**
 * MicButton — record a short voice clip, POST it to the transcribe
 * endpoint, and return the resulting transcript.
 *
 * State machine (driven by `useVoiceRecording`):
 *   idle ── click ──> recording ── click again / 3 min auto-stop ──> transcribing
 *                                                                    └── error ┘
 *                                                                    └── transcript ─> idle
 *
 * Accessibility:
 *   - The button's `aria-label` reflects the current action ("Start voice
 *     input" → "Stop recording, 0:12 elapsed").
 *   - State transitions are announced via a `role="status"` live region.
 *   - The button is disabled while `transcribing` so a second click doesn't
 *     fire a duplicate upload.
 *
 * Network:
 *   - POSTs FormData to `endpoint` with `audio` (Blob), `agentId`, and
 *     optional `language`.
 *   - Surfaces the standard `errorResponse` envelope (`{ error: { code,
 *     message } }`) verbatim — the chat surface formats them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { MicLevelMeter } from '@/components/admin/orchestration/chat/mic-level-meter';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';
import { useVoiceRecording, DEFAULT_MAX_DURATION_MS } from '@/lib/hooks/use-voice-recording';

/**
 * localStorage key for the one-time "Speak now — tap to stop" hint.
 * Bumped suffix → re-shows hint to existing users (use sparingly).
 */
const VOICE_HINT_DISMISSED_KEY = 'sunrise.voice-input.hint-dismissed.v1';

export interface MicButtonProps {
  /** Agent id used for the multipart `agentId` field. */
  agentId: string;
  /** Transcribe endpoint URL — admin: `/api/v1/admin/orchestration/chat/transcribe`. */
  endpoint: string;
  /** Optional ISO 639-1 language hint passed to the provider. */
  language?: string;
  /** Called with the transcript string on success. */
  onTranscript: (text: string) => void;
  /** Called with a user-facing error message (button surfaces nothing itself). */
  onError?: (message: string) => void;
  /** Disable the button (e.g. while the chat is streaming a reply). */
  disabled?: boolean;
  /** Override the client-side recording cap. */
  maxDurationMs?: number;
  /** Additional class names for the button element. */
  className?: string;
}

type SubmitState = 'idle' | 'transcribing' | 'error';

interface TranscribeResponseBody {
  success: boolean;
  data?: { text: string };
  error?: { code?: string; message?: string };
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MicButton({
  agentId,
  endpoint,
  language,
  onTranscript,
  onError,
  disabled = false,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  className,
}: MicButtonProps) {
  const recording = useVoiceRecording({ maxDurationMs });
  const [submit, setSubmit] = useState<SubmitState>('idle');
  // First-use coaching: show "Speak now — tap to stop" once, then never again.
  // Flipped to `true` the first time the user enters the `recording` state.
  const [hintDismissed, setHintDismissed] = useLocalStorage<boolean>(
    VOICE_HINT_DISMISSED_KEY,
    false
  );

  // Surface recording-layer errors through the same channel as transcribe errors.
  useEffect(() => {
    if (recording.error) {
      onError?.(recording.error.message);
    }
  }, [recording.error, onError]);

  // Mark the hint dismissed the moment the user reaches `recording` — they've
  // now seen the panel, so future sessions go straight to the level meter.
  useEffect(() => {
    if (recording.state === 'recording' && !hintDismissed) {
      setHintDismissed(true);
    }
  }, [recording.state, hintDismissed, setHintDismissed]);

  const ariaLabel = useMemo(() => {
    if (submit === 'transcribing') return 'Transcribing audio…';
    if (recording.state === 'recording') {
      return `Stop recording, ${formatElapsed(recording.elapsedMs)} elapsed`;
    }
    if (recording.state === 'requesting') return 'Requesting microphone access…';
    return 'Start voice input';
  }, [submit, recording.state, recording.elapsedMs]);

  const handleClick = useCallback(async () => {
    if (disabled || submit === 'transcribing') return;

    if (recording.state === 'idle') {
      await recording.start();
      return;
    }

    if (recording.state === 'recording') {
      const captured = await recording.stop();
      if (!captured) {
        // Either cancelled or the recorder produced no data — let any error
        // bubble up via the recording.error effect; nothing to send.
        return;
      }

      setSubmit('transcribing');
      try {
        const filename = captured.mimeType.startsWith('audio/mp4')
          ? 'audio.mp4'
          : captured.mimeType.startsWith('audio/webm')
            ? 'audio.webm'
            : captured.mimeType.startsWith('audio/ogg')
              ? 'audio.ogg'
              : 'audio.bin';
        const file = new File([captured.blob], filename, { type: captured.mimeType });
        const fd = new FormData();
        fd.append('audio', file);
        fd.append('agentId', agentId);
        if (language) fd.append('language', language);

        const res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });

        const body = (await res.json()) as TranscribeResponseBody;
        if (!res.ok || !body.success || !body.data?.text) {
          const code = body.error?.code ?? 'TRANSCRIPTION_FAILED';
          const message = body.error?.message ?? 'Transcription failed';
          onError?.(formatErrorMessage(code, message));
          setSubmit('error');
          // Reset to idle next tick so the button can be reused.
          window.setTimeout(() => setSubmit('idle'), 0);
          return;
        }

        onTranscript(body.data.text);
        setSubmit('idle');
      } catch (err) {
        onError?.(
          err instanceof Error
            ? `Could not reach the transcription service: ${err.message}`
            : 'Could not reach the transcription service'
        );
        setSubmit('error');
        window.setTimeout(() => setSubmit('idle'), 0);
      }
    }
  }, [agentId, disabled, endpoint, language, onError, onTranscript, recording, submit]);

  const isRecording = recording.state === 'recording';
  const isBusy = submit === 'transcribing' || recording.state === 'requesting';
  const buttonDisabled = disabled || isBusy;
  // Render the hint only on the very first session — once the user has seen
  // the panel during a record, the localStorage flag flips and we drop to the
  // level-meter-only layout from then on.
  const showHint = isRecording && !hintDismissed;

  return (
    <div className="relative inline-flex shrink-0">
      <Button
        type="button"
        size="sm"
        variant={isRecording ? 'destructive' : 'outline'}
        aria-label={ariaLabel}
        onClick={() => void handleClick()}
        disabled={buttonDisabled}
        className={cn('shrink-0', className)}
      >
        {submit === 'transcribing' ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : isRecording ? (
          <Square className="h-4 w-4 fill-current" aria-hidden="true" />
        ) : (
          <Mic className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>
      {isRecording && (
        <div
          // Positioned above the button so it doesn't push the input row
          // around mid-record. `right-0` anchors to the mic; on narrow
          // screens the panel still fits because the meter + timer is
          // ~140 px wide.
          className="bg-popover text-popover-foreground absolute right-0 bottom-full z-10 mb-2 flex flex-col gap-1 rounded-md border px-3 py-2 shadow-md"
          role="status"
          aria-live="polite"
          data-testid="mic-recording-indicator"
        >
          {showHint && (
            <p className="text-foreground text-xs font-medium whitespace-nowrap">
              Speak now — tap to stop
            </p>
          )}
          <div className="flex items-center gap-2">
            <MicLevelMeter stream={recording.stream} />
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {formatElapsed(recording.elapsedMs)}
            </span>
          </div>
        </div>
      )}
      {/* Recording state is already announced by the visible indicator
          panel above (role="status"). This live region covers the
          transcription phase, which has no visible affordance of its own. */}
      <span role="status" aria-live="polite" className="sr-only">
        {submit === 'transcribing' ? 'Transcribing audio…' : ''}
      </span>
    </div>
  );
}

function formatErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'VOICE_DISABLED':
      return 'Voice input is currently disabled. Ask an admin to enable it.';
    case 'NO_AUDIO_PROVIDER':
      return 'No speech-to-text provider is configured. Add an OpenAI provider with Whisper.';
    case 'AUDIO_TOO_LARGE':
      return 'The recording is too long. Please record a shorter clip.';
    case 'AUDIO_INVALID_TYPE':
      return 'This browser produced an audio format we cannot transcribe. Try a different browser.';
    case 'RATE_LIMITED':
      return 'Too many voice messages in a short time. Wait a minute and try again.';
    default:
      return fallback;
  }
}
