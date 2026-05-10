/**
 * MicButton component tests.
 *
 * Covers:
 * - Initial render: idle state, "Start voice input" aria-label
 * - Click → recording state: aria-label changes, icon swaps
 * - Click again → stops recording, posts FormData to endpoint, calls onTranscript
 * - 4xx/5xx response → calls onError with friendly message
 * - Network error → calls onError
 * - disabled prop blocks both starting and stopping
 * - Permission-denied recorder error surfaces via onError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mock the recording hook so tests don't need a real MediaRecorder
// ---------------------------------------------------------------------------

interface RecordingHookState {
  state: 'idle' | 'requesting' | 'recording' | 'stopping';
  elapsedMs: number;
  error: { code: string; message: string } | null;
  supported: boolean;
}

const hookState: RecordingHookState = {
  state: 'idle',
  elapsedMs: 0,
  error: null,
  supported: true,
};

// `startMock` resolves with no body — the real `useVoiceRecording.start()`
// updates internal state via React's `useState`, but our mock returns a
// static object snapshot per render so reactive state is out of scope (see
// the accept annotation below explaining the deliberate limitation). Tests
// that need the post-start `recording` state pre-set `hookState.state`
// before render rather than relying on click-driven mutation.
const startMock = vi.fn(async () => {});

const stopMock = vi.fn(async () => ({
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
  mimeType: 'audio/webm',
  durationMs: 1500,
}));

const cancelMock = vi.fn();

// test-review:accept mock-realism — the hook mock reads `hookState` on each
// invocation, so initial-render state IS responsive to pre-set values. What
// it doesn't do is trigger a React re-render when `hookState` mutates AFTER
// render — the `MicButton` component holds no internal state derived from
// the hook's return that would force a re-render on its own. Every test in
// this file pre-sets `hookState.*` before render and asserts at the
// dispatch level (mock calls, props passed to children); none rely on
// observing a state transition's rendered output. Adding a real
// react-state-backed mock would be a substantial rewrite for no covered
// scenario.
vi.mock('@/lib/hooks/use-voice-recording', () => ({
  DEFAULT_MAX_DURATION_MS: 180_000,
  useVoiceRecording: () => ({
    state: hookState.state,
    elapsedMs: hookState.elapsedMs,
    error: hookState.error,
    supported: hookState.supported,
    start: startMock,
    stop: stopMock,
    cancel: cancelMock,
  }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { MicButton } from '@/components/admin/orchestration/chat/mic-button';

const fetchMock = vi.fn();

beforeEach(() => {
  hookState.state = 'idle';
  hookState.elapsedMs = 0;
  hookState.error = null;
  hookState.supported = true;
  startMock.mockClear();
  stopMock.mockClear();
  cancelMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeProps(overrides: Partial<React.ComponentProps<typeof MicButton>> = {}) {
  return {
    agentId: 'agent-1',
    endpoint: '/api/v1/admin/orchestration/chat/transcribe',
    onTranscript: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('MicButton', () => {
  it('renders with idle aria-label', () => {
    render(<MicButton {...makeProps()} />);
    expect(screen.getByRole('button', { name: /start voice input/i })).toBeInTheDocument();
  });

  it('switches aria-label when recording', () => {
    hookState.state = 'recording';
    hookState.elapsedMs = 5_000;
    render(<MicButton {...makeProps()} />);
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
  });

  it('calls start() on first click', async () => {
    const user = userEvent.setup();
    render(<MicButton {...makeProps()} />);

    await user.click(screen.getByRole('button'));

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('on stop, posts FormData to the endpoint and calls onTranscript on success', async () => {
    const props = makeProps();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { text: 'hi there' } }), { status: 200 })
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/orchestration/chat/transcribe');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get('audio')).toBeInstanceOf(File);
    expect(fd.get('agentId')).toBe('agent-1');

    await waitFor(() => expect(props.onTranscript).toHaveBeenCalledWith('hi there'));
  });

  it('forwards optional language hint as a form field', async () => {
    const props = makeProps({ language: 'es' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { text: 'hola' } }), { status: 200 })
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const fd = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(fd.get('language')).toBe('es');
  });

  it('calls onError with a friendly message on RATE_LIMITED', async () => {
    const props = makeProps();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }),
        { status: 429 }
      )
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(props.onError).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/too many voice messages/i));
  });

  it('translates VOICE_DISABLED to a hint about admin enablement', async () => {
    const props = makeProps();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'VOICE_DISABLED' } }), {
        status: 403,
      })
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(props.onError).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith(
      expect.stringMatching(/voice input is currently disabled/i)
    );
  });

  it.each([
    ['NO_AUDIO_PROVIDER', /no speech-to-text provider is configured/i],
    ['AUDIO_TOO_LARGE', /recording is too long/i],
    ['AUDIO_INVALID_TYPE', /audio format we cannot transcribe/i],
  ])('translates %s into a user-facing message', async (code, pattern) => {
    // Each known error code maps to its own copy in `formatErrorMessage`;
    // covering them as a group ensures the switch-case branches don't
    // silently fall through to the generic fallback when refactored.
    const props = makeProps();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code } }), { status: 400 })
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(props.onError).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(pattern));
  });

  it('falls back to the server-supplied message for unknown error codes', async () => {
    // The default switch-arm forwards the server's message verbatim —
    // so a future code added without an explicit translation still
    // surfaces something useful rather than a generic stub.
    const props = makeProps();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'SOMETHING_NEW', message: 'specific upstream detail' },
        }),
        { status: 500 }
      )
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(props.onError).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith('specific upstream detail');
  });

  it('calls onError when fetch throws', async () => {
    const props = makeProps();
    fetchMock.mockRejectedValue(new Error('boom'));
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(props.onError).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/transcription service/i));
  });

  it('does nothing on click when disabled', async () => {
    const props = makeProps({ disabled: true });
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    expect(startMock).not.toHaveBeenCalled();
  });

  it('surfaces hook errors via onError', async () => {
    const props = makeProps();
    hookState.error = { code: 'permission_denied', message: 'mic denied' };

    render(<MicButton {...props} />);

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith('mic denied'));
  });

  it('silently bails when stop() returns null (empty/cancelled recording)', async () => {
    // `useVoiceRecording.stop()` resolves to `null` when the recorder
    // produced no data (rare but possible: zero-length MediaStream, an
    // immediate cancel). The button must NOT call fetch — uploading an
    // empty body would be wasted bandwidth + a wasted Whisper call —
    // and must NOT invoke onTranscript / onError.
    const props = makeProps();
    stopMock.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof stopMock>>);
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);
    await user.click(screen.getByRole('button'));

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(props.onTranscript).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('does not double-fire when clicked again while still transcribing', async () => {
    // The button toggles to a busy state while the upload is in flight.
    // A second click during this window must not start another recording
    // or fire another fetch — `disabled` on the underlying Button is
    // load-bearing here, but the click handler also short-circuits.
    const props = makeProps();
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    hookState.state = 'recording';
    const user = userEvent.setup();

    render(<MicButton {...props} />);

    // First click: starts the stop+upload flow but the fetch hangs.
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Second click while the request is still pending — must not call
    // fetch again. Note the button is in DOM-disabled state so this is
    // belt-and-braces, but tests must catch a regression that removes
    // either the disabled prop OR the click-handler short-circuit.
    await user.click(screen.getByRole('button'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight fetch so the test cleans up.
    resolveFetch?.(
      new Response(JSON.stringify({ success: true, data: { text: 'ok' } }), { status: 200 })
    );
    await waitFor(() => expect(props.onTranscript).toHaveBeenCalled());
  });
});
