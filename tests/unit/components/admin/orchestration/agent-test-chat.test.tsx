/**
 * AgentTestChat Component Tests
 *
 * Test Coverage:
 * - SSE `content` frames accumulate into assistant reply
 * - SSE `error` frame renders friendly fallback, never leaks raw error text
 * - `AbortController.abort()` is called on unmount during active stream
 *
 * @see components/admin/orchestration/agent-test-chat.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock MicButton with a minimal stand-in that exposes two buttons:
// one that fires `onTranscript` and one that fires `onError`.
// The real component drives a media-recorder state machine that we
// don't need to exercise here — we only want to verify how
// AgentTestChat reacts to the callbacks it passes in.
vi.mock('@/components/admin/orchestration/chat/mic-button', () => ({
  MicButton: (props: {
    onTranscript: (text: string) => void;
    onError?: (message: string) => void;
    disabled?: boolean;
  }) => (
    <>
      <button
        type="button"
        data-testid="mock-mic-transcript"
        disabled={props.disabled}
        onClick={() => props.onTranscript('voiced text')}
      >
        emit transcript
      </button>
      <button
        type="button"
        data-testid="mock-mic-error"
        onClick={() => props.onError?.('voice failed')}
      >
        emit error
      </button>
    </>
  ),
}));

// Mock ApprovalCard with a stand-in that renders the prompt and exposes
// approve / reject buttons that immediately call `onResolved`. The real
// component runs a multi-step submit-then-poll flow; we only care that
// AgentTestChat reacts correctly when `onResolved` fires. The button
// `aria-label`s match the real ones so existing assertions keep working.
vi.mock('@/components/admin/orchestration/chat/approval-card', () => ({
  ApprovalCard: (props: {
    pendingApproval: { prompt: string };
    onResolved: (action: 'approved' | 'rejected', followup: string) => void;
  }) => (
    <div>
      <p>{props.pendingApproval.prompt}</p>
      <button
        type="button"
        aria-label="Approve action"
        onClick={() => props.onResolved('approved', 'mock followup')}
      >
        Approve
      </button>
      <button
        type="button"
        aria-label="Reject action"
        onClick={() => props.onResolved('rejected', 'mock followup')}
      >
        Reject
      </button>
    </div>
  ),
}));

import { AgentTestChat } from '@/components/admin/orchestration/agent-test-chat';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
}

function contentFrame(text: string): string {
  return `event: content\ndata: ${JSON.stringify({ delta: text })}\n\n`;
}

function errorFrame(code: string, message?: string): string {
  return `event: error\ndata: ${JSON.stringify({ code, message: message ?? 'Error' })}\n\n`;
}

function warningFrame(code: string, message: string): string {
  return `event: warning\ndata: ${JSON.stringify({ code, message })}\n\n`;
}

function approvalRequiredFrame(pa: Record<string, unknown>): string {
  return `event: approval_required\ndata: ${JSON.stringify({ pendingApproval: pa })}\n\n`;
}

function doneFrame(): string {
  return `event: done\ndata: ${JSON.stringify({ tokenUsage: { input: 1, output: 1 }, costUsd: 0.001 })}\n\n`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AgentTestChat', () => {
  let originalAbortController: typeof AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    originalAbortController = globalThis.AbortController;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.AbortController = originalAbortController;
  });

  it('renders message input and send button', () => {
    // Arrange & Act
    render(<AgentTestChat agentSlug="my-agent" />);

    // Assert
    expect(screen.getByLabelText(/your message/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
  });

  it('renders initial message in textarea', () => {
    // Arrange & Act
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Say hello" />);

    // Assert
    expect(screen.getByLabelText(/your message/i)).toHaveValue('Say hello');
  });

  it('accumulates content SSE frames into assistant reply bubble', async () => {
    // Arrange
    const user = userEvent.setup();
    const stream = makeSseStream([
      contentFrame('Hello'),
      contentFrame(' world'),
      contentFrame('!'),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Assert — content frames join into one string
    await waitFor(() => {
      expect(screen.getByText('Hello world!')).toBeInTheDocument();
    });
  });

  it('renders structured error from error frame and does NOT leak raw error text', async () => {
    // Arrange — secret string must never reach the DOM
    const SECRET = `RAW_SDK_LEAK_${Date.now()}`;
    const user = userEvent.setup();
    const stream = makeSseStream([errorFrame('internal_error', SECRET)]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Assert: structured error shown (title from error registry)
    await waitFor(
      () => {
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Assert: raw secret never reaches DOM
    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('renders budget_exceeded error with specific message', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([errorFrame('budget_exceeded')]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/monthly budget reached/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('renders warning banner from warning event during streaming', async () => {
    // Use a controlled stream so warning is visible before stream completes
    const encoder = new TextEncoder();
    const resolver: { fn: (() => void) | null } = { fn: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(warningFrame('budget_warning', 'Agent at 85% budget')));
        controller.enqueue(encoder.encode(contentFrame('Hello')));
        resolver.fn = () => {
          controller.enqueue(
            encoder.encode(
              'event: done\ndata: {"tokenUsage":{"inputTokens":10,"outputTokens":5,"totalTokens":15},"costUsd":0.001}\n\n'
            )
          );
          controller.close();
        };
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/agent at 85% budget/i)).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    // Clean up
    resolver.fn?.();
  });

  it('clears warning banner after stream completes', async () => {
    // Use a controlled stream so we can observe the warning mid-stream
    const encoder = new TextEncoder();
    const resolver: { fn: (() => void) | null } = { fn: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(warningFrame('budget_warning', 'Agent at 85% budget')));
        controller.enqueue(encoder.encode(contentFrame('Hello')));
        resolver.fn = () => {
          controller.enqueue(
            encoder.encode('event: done\ndata: {"tokenUsage":{},"costUsd":0}\n\n')
          );
          controller.close();
        };
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Warning appears during streaming
    await waitFor(() => {
      expect(screen.getByText(/agent at 85% budget/i)).toBeInTheDocument();
    });

    // Close the stream — finally block should clear the warning
    resolver.fn?.();
    await waitFor(() => {
      expect(screen.queryByText(/agent at 85% budget/i)).not.toBeInTheDocument();
    });
  });

  it('clears reply on content_reset event (provider fallback)', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      contentFrame('Stale text from failed provider'),
      'event: content_reset\ndata: {"reason":"provider_fallback"}\n\n',
      contentFrame('Fresh response'),
      'event: done\ndata: {"tokenUsage":{},"costUsd":0}\n\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText('Fresh response')).toBeInTheDocument();
    });

    // Stale text should have been cleared
    expect(screen.queryByText(/Stale text from failed provider/i)).not.toBeInTheDocument();
  });

  it('calls AbortController.abort() on unmount during active stream', async () => {
    // Arrange — create a stream that never resolves so we are mid-stream at unmount
    const abortMock = vi.fn();
    const neverResolves = new ReadableStream<Uint8Array>({
      start() {
        // intentionally never enqueues or closes
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: neverResolves }));

    // Intercept AbortController to capture the abort call
    const OriginalController = globalThis.AbortController;
    const MockController = class extends OriginalController {
      override abort() {
        abortMock();
        super.abort();
      }
    };
    globalThis.AbortController = MockController as typeof AbortController;

    const user = userEvent.setup();
    const { unmount } = render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act: start the stream
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Allow fetch to be initiated
    await new Promise<void>((r) => setTimeout(r, 0));

    // Act: unmount while streaming
    unmount();

    // Assert: abort was called
    expect(abortMock).toHaveBeenCalledOnce();
  });

  it('restores focus to the textarea after a turn completes', async () => {
    // The textarea is `disabled={streaming}`, which drops focus when
    // a turn starts. Without a refocus on the streaming → idle
    // transition, the user has to click back into the textarea
    // before sending the next message.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(contentFrame('hello')));
        controller.enqueue(
          new TextEncoder().encode('event: done\ndata: {"tokenUsage":{},"costUsd":0}\n\n')
        );
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    const textarea = screen.getByLabelText(/your message/i);
    // Click send — moves focus to the button and disables the textarea.
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(textarea).not.toBeDisabled();
    });
    await waitFor(() => {
      expect(textarea).toHaveFocus();
    });
  });

  it('shows streaming indicator while request is in-flight', async () => {
    // Arrange — stream that resolves after a tick
    let resolve: (() => void) | null = null;
    const delayed = new ReadableStream<Uint8Array>({
      start(controller) {
        resolve = () => {
          controller.enqueue(new TextEncoder().encode(contentFrame('hi')));
          controller.close();
        };
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: delayed }));

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act: click send
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Assert: streaming button shown
    await waitFor(() => {
      expect(screen.getByText(/streaming/i)).toBeInTheDocument();
    });

    // Clean up: close stream (resolve is set by the ReadableStream start callback)
    const flush: { fn: (() => void) | null } = { fn: resolve };
    flush.fn?.();
    await waitFor(() => {
      expect(screen.queryByText(/streaming/i)).not.toBeInTheDocument();
    });
  });

  it('shows inline status from status SSE event during streaming', async () => {
    const resolver: { fn: (() => void) | null } = { fn: null };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentFrame('Working...')));
        controller.enqueue(
          encoder.encode(
            `event: status\ndata: ${JSON.stringify({ message: 'Executing search_documents' })}\n\n`
          )
        );
        resolver.fn = () => {
          controller.enqueue(
            encoder.encode('event: done\ndata: {"tokenUsage":{},"costUsd":0}\n\n')
          );
          controller.close();
        };
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Status should appear inline during streaming
    await waitFor(() => {
      expect(screen.getByText('Executing search_documents')).toBeInTheDocument();
    });

    // Clean up
    resolver.fn?.();
    await waitFor(() => {
      expect(screen.queryByText('Executing search_documents')).not.toBeInTheDocument();
    });
  });

  it('shows connection lost error on network failure (no retry)', async () => {
    // Arrange — fetch rejects; chat POSTs are not idempotent so no retry
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Assert — error shown after brief thinking delay (no reconnect attempts)
    await waitFor(
      () => {
        expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
        expect(screen.getByText(/chat stream was interrupted/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Assert — fetch was only called once (no retries)
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('mounts an ApprovalCard when the SSE stream emits approval_required', async () => {
    const user = userEvent.setup();
    const pa = {
      executionId: 'cmexec999validid01234567',
      stepId: 'step-1',
      prompt: 'Confirm the test action?',
      expiresAt: '2030-01-01T00:00:00.000Z',
      approveToken: 'tok-a',
      rejectToken: 'tok-r',
    };
    const stream = makeSseStream([
      contentFrame('Starting test workflow. '),
      approvalRequiredFrame(pa),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Run test workflow" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Card prompt + Approve / Reject visible inside the test chat
    await waitFor(() => {
      expect(screen.getByText('Confirm the test action?')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /approve action/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject action/i })).toBeInTheDocument();
  });

  it('updates the textarea value as the user types (onChange)', async () => {
    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" />);

    const textarea = screen.getByLabelText(/your message/i);
    await user.type(textarea, 'hello world');

    expect(textarea).toHaveValue('hello world');
  });

  it('submits when Enter is pressed in the textarea', async () => {
    // Stream completes immediately so we can observe the streaming flag flip.
    const stream = makeSseStream([contentFrame('ack'), doneFrame()]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="hello" />);

    // Focus the textarea then press Enter — should fire handleSend
    // without needing to click the Send button.
    const textarea = screen.getByLabelText(/your message/i);
    textarea.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('ack')).toBeInTheDocument();
    });
  });

  it('does NOT submit when Shift+Enter is pressed (newline only)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" initialMessage="hello" />);

    const textarea = screen.getByLabelText(/your message/i);
    textarea.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    // Shift+Enter inserts a newline — the form should not submit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Send button is type="button" so it cannot submit a parent <form>', () => {
    // Regression: AgentTestChat is embedded inside the AgentForm <form>
    // on the agent edit page's Test tab. If the Send button were
    // type="submit", clicking it would submit the outer form and
    // bounce the user back to the General tab. The button must be
    // type="button" with an explicit onClick handler.
    render(<AgentTestChat agentSlug="my-agent" initialMessage="hello" />);
    const send = screen.getByRole('button', { name: /^send$/i });
    expect(send).toBeInstanceOf(HTMLButtonElement);
    expect((send as HTMLButtonElement).type).toBe('button');
  });

  it('clicking Send does not trigger an enclosing <form>.onSubmit', async () => {
    // Simulates the real layout: AgentTestChat lives inside another
    // form. If the Send button submits the wrapping form, the test
    // will record an outerSubmit call — which we assert never happens.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, body: makeSseStream([contentFrame('ack'), doneFrame()]) });
    vi.stubGlobal('fetch', fetchMock);
    const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={outerSubmit} data-testid="outer-form">
        <AgentTestChat agentSlug="my-agent" initialMessage="hello" />
      </form>
    );

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    // Critical assertion: the outer form must not have been submitted.
    expect(outerSubmit).not.toHaveBeenCalled();
  });

  it('shows a "Missing Agent" error when handleSend runs without an agentSlug', async () => {
    // Empty slug exercises the `if (!agentSlug)` early-return branch.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="" initialMessage="hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(screen.getByText(/missing agent/i)).toBeInTheDocument();
    expect(screen.getByText(/no agent slug/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appends a transcript from voice input into an empty textarea', async () => {
    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" agentId="agent-123" voiceInputEnabled={true} />);

    // Empty path — `current` is falsy, so the transcript replaces it
    // verbatim (no leading space).
    await user.click(screen.getByTestId('mock-mic-transcript'));

    expect(screen.getByLabelText(/your message/i)).toHaveValue('voiced text');
  });

  it('appends a transcript with a leading space when the textarea already has text', async () => {
    const user = userEvent.setup();
    render(
      <AgentTestChat
        agentSlug="my-agent"
        agentId="agent-123"
        voiceInputEnabled={true}
        initialMessage="say"
      />
    );

    // Non-empty path — the existing message is `trimEnd`-ed and joined
    // with a single space before the transcript.
    await user.click(screen.getByTestId('mock-mic-transcript'));

    expect(screen.getByLabelText(/your message/i)).toHaveValue('say voiced text');
  });

  it('surfaces a "Voice input failed" error when MicButton onError fires', async () => {
    const user = userEvent.setup();
    render(<AgentTestChat agentSlug="my-agent" agentId="agent-123" voiceInputEnabled={true} />);

    await user.click(screen.getByTestId('mock-mic-error'));

    expect(screen.getByText(/voice input failed/i)).toBeInTheDocument();
    expect(screen.getByText(/voice failed/i)).toBeInTheDocument();
  });

  it('hides MicButton when voiceInputEnabled is true but agentId is missing', () => {
    // Wizard surface mounts AgentTestChat before the agent has an id —
    // the mic must not render in that state.
    render(<AgentTestChat agentSlug="my-agent" voiceInputEnabled={true} />);

    expect(screen.queryByTestId('mock-mic-transcript')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-mic-error')).not.toBeInTheDocument();
  });

  it('shows the approved notice and clears the card when ApprovalCard.onResolved fires with "approved"', async () => {
    const user = userEvent.setup();
    const pa = {
      executionId: 'cmexec999validid01234567',
      stepId: 'step-1',
      prompt: 'Confirm the test action?',
      expiresAt: '2030-01-01T00:00:00.000Z',
      approveToken: 'tok-a',
      rejectToken: 'tok-r',
    };
    const stream = makeSseStream([approvalRequiredFrame(pa), doneFrame()]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Run test workflow" />);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    const approveBtn = await screen.findByRole('button', { name: /approve action/i });
    await user.click(approveBtn);

    // After resolution: card is cleared, approved notice shows.
    await waitFor(() => {
      expect(screen.getByText(/workflow approved and completed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Confirm the test action?')).not.toBeInTheDocument();
  });

  it('shows the rejected notice when ApprovalCard.onResolved fires with "rejected"', async () => {
    const user = userEvent.setup();
    const pa = {
      executionId: 'cmexec999validid01234567',
      stepId: 'step-1',
      prompt: 'Confirm the test action?',
      expiresAt: '2030-01-01T00:00:00.000Z',
      approveToken: 'tok-a',
      rejectToken: 'tok-r',
    };
    const stream = makeSseStream([approvalRequiredFrame(pa), doneFrame()]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Run test workflow" />);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    const rejectBtn = await screen.findByRole('button', { name: /reject action/i });
    await user.click(rejectBtn);

    await waitFor(() => {
      expect(screen.getByText(/workflow rejected/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Confirm the test action?')).not.toBeInTheDocument();
  });

  it('drops a malformed approval_required payload silently (Zod parse fails closed)', async () => {
    const user = userEvent.setup();
    // Missing required fields (no executionId / stepId / tokens) — fails
    // pendingApprovalSchema.safeParse, so no card should mount.
    const malformedPa = { prompt: 'too short to be valid' };
    const stream = makeSseStream([
      contentFrame('Starting test workflow. '),
      approvalRequiredFrame(malformedPa),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Run test workflow" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Wait for the streamed text to land (proves the SSE pipeline ran)
    await waitFor(() => {
      expect(screen.getByText(/Starting test workflow/)).toBeInTheDocument();
    });

    // Card should NOT mount — the prompt text doesn't appear and neither
    // does the Approve/Reject button pair.
    expect(screen.queryByText('too short to be valid')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve action/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject action/i })).not.toBeInTheDocument();
  });
});
