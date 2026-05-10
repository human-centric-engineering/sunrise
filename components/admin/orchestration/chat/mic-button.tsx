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
import { cn } from '@/lib/utils';
import { useVoiceRecording, DEFAULT_MAX_DURATION_MS } from '@/lib/hooks/use-voice-recording';

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

  // Surface recording-layer errors through the same channel as transcribe errors.
  useEffect(() => {
    if (recording.error) {
      onError?.(recording.error.message);
    }
  }, [recording.error, onError]);

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

  return (
    <>
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
      <span role="status" aria-live="polite" className="sr-only">
        {isRecording
          ? `Recording, ${formatElapsed(recording.elapsedMs)} elapsed.`
          : submit === 'transcribing'
            ? 'Transcribing audio…'
            : ''}
      </span>
    </>
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
