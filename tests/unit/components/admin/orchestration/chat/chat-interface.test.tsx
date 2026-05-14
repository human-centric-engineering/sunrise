/**
 * ChatInterface Component Tests
 *
 * Test coverage:
 * - Renders starter prompts when no messages
 * - Clicking a starter prompt sends that message
 * - Streaming renders user + assistant messages
 * - Error frame shows friendly message
 * - Calls onCapabilityResult when capability_result event arrives
 * - Calls onStreamComplete with full text when done event arrives
 * - Tracks conversationId from start event
 *
 * @see components/admin/orchestration/chat/chat-interface.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock MicButton with a stub that preserves the real button's
// accessible name (so existing rendering tests still pass) and adds
// two hidden control buttons (`fire-transcript`, `fire-error`) that
// invoke the `onTranscript` / `onError` callbacks. This is the only
// reliable way to exercise those callbacks without driving the real
// MediaRecorder + fetch pipeline through jsdom.
vi.mock('@/components/admin/orchestration/chat/mic-button', () => ({
  MicButton: ({
    onTranscript,
    onError,
    disabled,
  }: {
    agentId: string;
    endpoint: string;
    disabled?: boolean;
    onTranscript: (text: string) => void;
    onError: (message: string) => void;
  }) => (
    <>
      <button type="button" aria-label="Start voice input" disabled={disabled}>
        mic
      </button>
      <button
        type="button"
        data-testid="fire-transcript"
        onClick={() => onTranscript('hello from the mic')}
      >
        fire-transcript
      </button>
      <button
        type="button"
        data-testid="fire-error"
        onClick={() => onError('Microphone unavailable')}
      >
        fire-error
      </button>
    </>
  ),
}));

import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';

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

function startFrame(conversationId: string, messageId: string): string {
  return `event: start\ndata: ${JSON.stringify({ conversationId, messageId })}\n\n`;
}

function contentFrame(text: string): string {
  return `event: content\ndata: ${JSON.stringify({ delta: text })}\n\n`;
}

function capabilityFrame(slug: string, result: unknown): string {
  return `event: capability_result\ndata: ${JSON.stringify({ capabilitySlug: slug, result })}\n\n`;
}

function doneFrame(): string {
  return `event: done\ndata: ${JSON.stringify({ tokenUsage: { input: 10, output: 5 }, costUsd: 0.001 })}\n\n`;
}

function errorFrame(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ code: 'internal_error', message })}\n\n`;
}

function statusFrame(message: string): string {
  return `event: status\ndata: ${JSON.stringify({ message })}\n\n`;
}

function capabilityResultsFrame(
  results: Array<{ capabilitySlug: string; result: unknown }>
): string {
  return `event: capability_results\ndata: ${JSON.stringify({ results })}\n\n`;
}

function citationsFrame(citations: Array<Record<string, unknown>>): string {
  return `event: citations\ndata: ${JSON.stringify({ citations })}\n\n`;
}

function approvalRequiredFrame(pa: Record<string, unknown>): string {
  return `event: approval_required\ndata: ${JSON.stringify({ pendingApproval: pa })}\n\n`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ChatInterface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders starter prompt buttons when no messages exist', () => {
    render(<ChatInterface agentSlug="test-agent" starterPrompts={['Hello', 'Help me']} />);

    expect(screen.getByRole('button', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help me' })).toBeInTheDocument();
  });

  it('does not render starter prompts when none provided', () => {
    render(<ChatInterface agentSlug="test-agent" />);

    expect(screen.queryByText(/try asking/i)).not.toBeInTheDocument();
  });

  it('clicking a starter prompt sends that message', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Reply'),
      doneFrame(),
    ]);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatInterface agentSlug="test-agent" starterPrompts={['Hello agent']} />);

    await user.click(screen.getByRole('button', { name: 'Hello agent' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.message).toBe('Hello agent');
    expect(body.agentSlug).toBe('test-agent');
  });

  it('renders user and assistant messages during streaming', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Hello'),
      contentFrame(' world!'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi there');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hi there')).toBeInTheDocument();
      expect(screen.getByText('Hello world!')).toBeInTheDocument();
    });
  });

  it('shows friendly fallback on error frame', async () => {
    const SECRET = `RAW_LEAK_${Date.now()}`;
    const user = userEvent.setup();
    const stream = makeSseStream([errorFrame(SECRET)]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // MIN_THINKING_MS delay before error appears
    await waitFor(
      () => {
        // getUserFacingError('internal_error') → title: 'Something Went Wrong'
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('calls onCapabilityResult when capability_result event arrives', async () => {
    const user = userEvent.setup();
    const onCapabilityResult = vi.fn();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      capabilityFrame('search_knowledge_base', { results: [] }),
      contentFrame('Found nothing.'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" onCapabilityResult={onCapabilityResult} />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Search');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(onCapabilityResult).toHaveBeenCalledWith('search_knowledge_base', { results: [] });
    });
  });

  it('calls onCapabilityResult for each result in capability_results (plural) event', async () => {
    const user = userEvent.setup();
    const onCapabilityResult = vi.fn();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      capabilityResultsFrame([
        { capabilitySlug: 'search_docs', result: { hits: 3 } },
        { capabilitySlug: 'fetch_url', result: { status: 200 } },
      ]),
      contentFrame('Done.'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" onCapabilityResult={onCapabilityResult} />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Search');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(onCapabilityResult).toHaveBeenCalledTimes(2);
      expect(onCapabilityResult).toHaveBeenCalledWith('search_docs', { hits: 3 });
      expect(onCapabilityResult).toHaveBeenCalledWith('fetch_url', { status: 200 });
    });
  });

  it('attaches citations to the assistant message when a citations event arrives', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Deposits must be protected within 30 days [1].'),
      citationsFrame([
        {
          marker: 1,
          chunkId: 'c1',
          documentId: 'd1',
          documentName: 'Tenancy Guide',
          section: 'Page 12',
          patternNumber: null,
          patternName: null,
          excerpt: 'Deposits must be protected within 30 days of receipt.',
          similarity: 0.91,
        },
      ]),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Tell me about deposit rules');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // Marker chip and panel heading render straight away; the panel
    // contents are only revealed once the user expands the (default-
    // collapsed) sources list.
    await waitFor(() => {
      expect(screen.getByLabelText('Citation 1')).toBeInTheDocument();
      expect(screen.getByText('Sources (1)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /sources \(1\)/i }));
    expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
  });

  it('does not transform [N] literals when no citations event fires', async () => {
    // Regression: a non-RAG response that mentions `[5]` must not get
    // any marker substitution if there are no citations attached.
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('See paragraph [5] of the manual.'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('See paragraph [5] of the manual.')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Unmatched citation marker/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
  });

  it('calls onStreamComplete with full text when done event arrives', async () => {
    const user = userEvent.setup();
    const onStreamComplete = vi.fn();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Part 1 '),
      contentFrame('Part 2'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" onStreamComplete={onStreamComplete} />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(onStreamComplete).toHaveBeenCalledWith('Part 1 Part 2');
    });
  });

  it('restores focus to the input after a turn completes', async () => {
    // The input is `disabled={streaming}`, which drops focus when a
    // turn starts. Without a refocus on the streaming → idle
    // transition, the user has to click back into the input before
    // typing the next message.
    const user = userEvent.setup();
    const stream = makeSseStream([startFrame('conv-1', 'msg-1'), contentFrame('hi'), doneFrame()]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello');
    // Click the send button — this moves focus to the button and the
    // input is disabled while streaming, so the input definitely
    // doesn't have focus mid-turn.
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it('tracks conversationId from start event for subsequent messages', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    // First message
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([startFrame('conv-123', 'msg-1'), contentFrame('Hi!'), doneFrame()]),
    });

    // Second message
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([startFrame('conv-123', 'msg-2'), contentFrame('Sure!'), doneFrame()]),
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);

    // Send first message
    await user.type(input, 'Hello');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hi!')).toBeInTheDocument();
    });

    // Send second message
    await user.type(input, 'Follow up');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<
      string,
      unknown
    >;
    expect(secondBody.conversationId).toBe('conv-123');
  });

  it('shows friendly fallback when fetch throws after retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // Advance through reconnect attempts (1s + 2s + 4s backoff)
    await vi.advanceTimersByTimeAsync(8000);

    await waitFor(() => {
      expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('shows reconnecting warning during retry attempts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    // Fail first, then succeed on second attempt
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new Error('Network error'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([startFrame('conv-1', 'msg-1'), contentFrame('Recovered!'), doneFrame()]),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // After first failure, warning should appear
    await waitFor(() => {
      expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    });

    // Advance past the backoff delay
    await vi.advanceTimersByTimeAsync(2000);

    // After reconnect succeeds, content should appear
    await waitFor(() => {
      expect(screen.getByText('Recovered!')).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('renders in embedded mode without card wrapper', () => {
    const { container } = render(<ChatInterface agentSlug="test-agent" embedded />);

    // Embedded mode should not have a rounded-lg border wrapper
    expect(container.querySelector('.rounded-lg.border')).toBeNull();
  });

  it('renders in standalone mode with card wrapper', () => {
    const { container } = render(<ChatInterface agentSlug="test-agent" />);

    expect(container.querySelector('.rounded-lg.border')).not.toBeNull();
  });

  it('shows status text from status event and clears on completion', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      statusFrame('Searching knowledge base...'),
      contentFrame('Found results.'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Search');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Found results.')).toBeInTheDocument();
    });

    // Status should be cleared after streaming completes (finally block sets status to null)
    expect(screen.queryByText('Searching knowledge base...')).not.toBeInTheDocument();
  });

  it('shows error and removes pending message when res.ok is false', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // MIN_THINKING_MS delay before error appears
    await waitFor(
      () => {
        // getUserFacingError('stream_error') → title: 'Unable to Connect'
        expect(screen.getByText(/unable to connect/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // User message should still be visible, but the empty assistant message should be removed
    expect(screen.getByText('Hi')).toBeInTheDocument();
    // There should be exactly one message row (the user's), not two
    const messageRows = document.querySelectorAll('.flex.font-mono');
    expect(messageRows).toHaveLength(1);
  });

  it('shows rate limit error on 429 response', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, body: null }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(
      () => {
        // getUserFacingError('rate_limited') → title: 'Too Many Requests'
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  // ─── Clear conversation tests ───────────────────────────────────────────────

  it('shows clear button when showClearButton is true and messages exist', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Hello!'),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" showClearButton />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hello!')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /clear conversation/i })).toBeInTheDocument();
  });

  it('does not show clear button when showClearButton is false', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Reply'),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Reply')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /clear conversation/i })).not.toBeInTheDocument();
  });

  it('clears messages and calls DELETE when clear button is confirmed', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([startFrame('conv-42', 'msg-1'), contentFrame('Hi!'), doneFrame()]),
    });
    // DELETE call for conversation clear
    fetchMock.mockResolvedValueOnce({ ok: true });

    vi.stubGlobal('fetch', fetchMock);
    const onCleared = vi.fn();

    render(
      <ChatInterface agentSlug="test-agent" showClearButton onConversationCleared={onCleared} />
    );

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hi!')).toBeInTheDocument();
    });

    // Click clear button then confirm
    await user.click(screen.getByRole('button', { name: /clear conversation/i }));
    await user.click(screen.getByRole('button', { name: /clear/i }));

    await waitFor(() => {
      expect(screen.queryByText('Hi!')).not.toBeInTheDocument();
      expect(screen.queryByText('Hello')).not.toBeInTheDocument();
    });

    // Should have called DELETE
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deleteCall = fetchMock.mock.calls[1];
    expect(deleteCall[1].method).toBe('DELETE');

    expect(onCleared).toHaveBeenCalledOnce();
  });

  // ─── Download transcript tests ─────────────────────────────────────────────

  it('shows download button when showDownloadButton is true and messages exist', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Hello!'),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" showDownloadButton />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hello!')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /download transcript/i })).toBeInTheDocument();
  });

  it('does not show download button when no messages have been sent', () => {
    render(<ChatInterface agentSlug="test-agent" showDownloadButton />);
    expect(screen.queryByRole('button', { name: /download transcript/i })).not.toBeInTheDocument();
  });

  it('triggers a markdown blob download when the download button is clicked', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Hello!'),
      doneFrame(),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(
      <ChatInterface agentSlug="test-agent" showDownloadButton downloadFilename="my-transcript" />
    );

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hello!')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /download transcript/i }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    clickSpy.mockRestore();
  });

  // ─── Input-clear (in-textarea X) tests ─────────────────────────────────────

  it('does not show the input-clear X when the textarea is empty', () => {
    render(<ChatInterface agentSlug="test-agent" />);
    expect(screen.queryByRole('button', { name: /clear input/i })).not.toBeInTheDocument();
  });

  it('shows the input-clear X once the operator types into the textarea', async () => {
    const user = userEvent.setup();
    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'draft message');

    expect(screen.getByRole('button', { name: /clear input/i })).toBeInTheDocument();
  });

  it('clicking the input-clear X empties the textarea without touching the conversation', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'something I changed my mind about');
    expect(input).toHaveValue('something I changed my mind about');

    await user.click(screen.getByRole('button', { name: /clear input/i }));

    expect(input).toHaveValue('');
    // No network calls — clearing input must not delete the conversation.
    expect(fetchMock).not.toHaveBeenCalled();
    // X disappears once the field is empty.
    expect(screen.queryByRole('button', { name: /clear input/i })).not.toBeInTheDocument();
  });

  // ─── Thinking indicator tests ──────────────────────────────────────────────

  it('shows ThinkingIndicator in empty assistant bubble during streaming', async () => {
    // Create a stream that doesn't immediately complete — use a stalling approach
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      statusFrame('Searching knowledge base...'),
      contentFrame('Found results.'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Search');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // After streaming completes, the content should be visible
    await waitFor(() => {
      expect(screen.getByText('Found results.')).toBeInTheDocument();
    });
  });

  // ─── Inline status tests ──────────────────────────────────────────────────

  it('shows inline status below content during streaming', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Working on it...'),
      statusFrame('Executing search_documents'),
      contentFrame(' Done!'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Search');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // Final content should be visible
    await waitFor(() => {
      expect(screen.getByText('Working on it... Done!')).toBeInTheDocument();
    });

    // Status should be cleared after streaming completes (finally block)
    expect(screen.queryByText('Executing search_documents')).not.toBeInTheDocument();
  });

  // ─── Warning event tests ──────────────────────────────────────────────────

  it('shows and clears warning from SSE warning event', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      'event: warning\ndata: ' + JSON.stringify({ message: 'Token limit approaching' }) + '\n\n',
      contentFrame('Result'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Test');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // After done, warning should be cleared (done event clears it, then finally also clears)
    await waitFor(() => {
      expect(screen.getByText('Result')).toBeInTheDocument();
    });

    expect(screen.queryByText('Token limit approaching')).not.toBeInTheDocument();
  });

  it('handles content_reset by clearing accumulated content', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Old content'),
      'event: content_reset\ndata: {}\n\n',
      contentFrame('New content'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('New content')).toBeInTheDocument();
    });

    // Old content should have been cleared by content_reset
    expect(screen.queryByText('Old content')).not.toBeInTheDocument();
  });

  it('renders with typing animation enabled', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Hello world'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(
      <ChatInterface
        agentSlug="test-agent"
        enableTypingAnimation
        typingAnimationOptions={{ chunkSize: 100, intervalMs: 1 }}
      />
    );

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });
  });

  it('clears conversation when no conversationId exists', async () => {
    const onCleared = vi.fn();

    render(
      <ChatInterface agentSlug="test-agent" showClearButton onConversationCleared={onCleared} />
    );

    // No messages, no clear button should appear
    expect(screen.queryByRole('button', { name: /clear conversation/i })).not.toBeInTheDocument();
  });

  it('submits on Enter key', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Reply'),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello{Enter}');

    await waitFor(() => {
      expect(screen.getByText('Reply')).toBeInTheDocument();
    });
  });

  it('shows error.action text when present', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // Advance through reconnect attempts
    await vi.advanceTimersByTimeAsync(8000);

    await waitFor(() => {
      expect(screen.getByText(/please try sending your message again/i)).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('handles stream ending without done/error event', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Partial response'),
      // No done or error frame — stream just ends
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText('Partial response')).toBeInTheDocument();
    });
  });

  it('shows error when res.body is null despite res.ok', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // MIN_THINKING_MS delay before error appears
    await waitFor(
      () => {
        // getUserFacingError('stream_error') → title: 'Unable to Connect'
        expect(screen.getByText(/unable to connect/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('mounts an ApprovalCard from an approval_required SSE event', async () => {
    const user = userEvent.setup();
    const pa = {
      executionId: 'cmexec999validid01234567',
      stepId: 'step-1',
      prompt: 'Refund £42.50?',
      expiresAt: '2030-01-01T00:00:00.000Z',
      approveToken: 'tok-a',
      rejectToken: 'tok-r',
    };
    const stream = makeSseStream([
      startFrame('conv-1', 'msg-1'),
      contentFrame('Starting refund. '),
      approvalRequiredFrame(pa),
      doneFrame(),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Refund order');
    await user.click(screen.getByRole('button', { name: /send/i }));

    // Card prompt + buttons render
    await waitFor(() => {
      expect(screen.getByText('Refund £42.50?')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /approve action/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject action/i })).toBeInTheDocument();
    // Streaming text from the same turn is also visible
    expect(screen.getByText(/Starting refund\./)).toBeInTheDocument();
  });

  // ── Mic / voice-input affordance ─────────────────────────────────────────

  describe('voice input', () => {
    // The mic affordance is opt-in via `voiceInputEnabled` + `agentId`.
    // Callers without an agent record (e.g. embedded contexts that
    // only know the slug) keep the current text-only UX; callers
    // that wire both props through get a mic next to Send. Mirrors
    // the gate used by `agent-test-chat.tsx`.

    it('renders the MicButton when voiceInputEnabled and agentId are both set', () => {
      render(<ChatInterface agentSlug="pattern-advisor" agentId="agent-123" voiceInputEnabled />);

      expect(screen.getByRole('button', { name: /start voice input/i })).toBeInTheDocument();
    });

    it('does not render the MicButton when voiceInputEnabled is false', () => {
      render(
        <ChatInterface agentSlug="pattern-advisor" agentId="agent-123" voiceInputEnabled={false} />
      );

      expect(screen.queryByRole('button', { name: /start voice input/i })).not.toBeInTheDocument();
    });

    it('does not render the MicButton when agentId is missing', () => {
      // Defensive: voiceInputEnabled alone isn't enough — the
      // transcribe endpoint needs an agentId to resolve the row's
      // `enableVoiceInput` field. Rendering the mic without an id
      // would let the operator click into a 4xx.
      render(<ChatInterface agentSlug="pattern-advisor" voiceInputEnabled />);

      expect(screen.queryByRole('button', { name: /start voice input/i })).not.toBeInTheDocument();
    });

    it('appends mic transcripts to the existing input value', async () => {
      // The mic transcript should accumulate onto whatever the
      // operator has already typed — same UX as agent-test-chat. The
      // mock above fires "hello from the mic" when `fire-transcript`
      // is clicked; assert the input ends up with both halves.
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="pattern-advisor" agentId="agent-123" voiceInputEnabled />);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const input = screen.getByPlaceholderText(/type a message/i) as HTMLInputElement;
      await user.type(input, 'tell me about');
      await user.click(screen.getByTestId('fire-transcript'));

      expect(input.value).toBe('tell me about hello from the mic');
    });

    it('uses the transcript as the input value when nothing has been typed yet', async () => {
      // Empty input path — the conditional in the callback writes the
      // raw transcript without a leading space.
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="pattern-advisor" agentId="agent-123" voiceInputEnabled />);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const input = screen.getByPlaceholderText(/type a message/i) as HTMLInputElement;
      await user.click(screen.getByTestId('fire-transcript'));

      expect(input.value).toBe('hello from the mic');
    });

    it('surfaces mic errors through the standard error banner', async () => {
      // The onError arrow promotes the message to the same
      // `UserFacingError` channel that SSE failures use. Confirms the
      // banner reads "Voice input failed" with the upstream message.
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="pattern-advisor" agentId="agent-123" voiceInputEnabled />);

      await user.click(screen.getByTestId('fire-error'));

      expect(screen.getByText(/voice input failed/i)).toBeInTheDocument();
      expect(screen.getByText(/microphone unavailable/i)).toBeInTheDocument();
    });
  });

  describe('Nested-form safety', () => {
    it('Send button is type="button" (cannot submit a parent form)', () => {
      // Regression: ChatInterface is mounted inside the AgentForm
      // <form> on the agent edit page's Test tab. HTML5 collapses
      // nested forms, so a type="submit" button here would submit the
      // outer form — refreshing the page and bouncing the user back
      // to the General tab. The button must be type="button".
      render(<ChatInterface agentSlug="my-agent" />);
      const send = screen.getByRole('button', { name: /send/i });
      expect(send).toBeInstanceOf(HTMLButtonElement);
      expect((send as HTMLButtonElement).type).toBe('button');
    });

    it('clicking Send inside a parent <form> does not trigger that form.onSubmit', async () => {
      const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseStream([startFrame('c', 'm'), contentFrame('ack'), doneFrame()]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      render(
        <form onSubmit={outerSubmit} data-testid="outer-form">
          <ChatInterface agentSlug="my-agent" />
        </form>
      );

      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      // Critical assertion: the outer form must NOT have been
      // submitted (which would refresh the page in a real browser).
      expect(outerSubmit).not.toHaveBeenCalled();
    });

    it('Enter-to-send inside a parent <form> does not trigger that form.onSubmit', async () => {
      const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseStream([startFrame('c', 'm'), contentFrame('ack'), doneFrame()]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      render(
        <form onSubmit={outerSubmit}>
          <ChatInterface agentSlug="my-agent" />
        </form>
      );

      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello{Enter}');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      expect(outerSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Attachment input', () => {
    it('does not render the attachment picker when neither toggle is on', () => {
      render(<ChatInterface agentSlug="my-agent" />);
      expect(screen.queryByRole('button', { name: /attach an image/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /attach a pdf/i })).not.toBeInTheDocument();
    });

    it('renders an image-only picker when only imageInputEnabled is true', () => {
      render(<ChatInterface agentSlug="my-agent" imageInputEnabled />);
      expect(screen.getByRole('button', { name: /attach an image/i })).toBeInTheDocument();
    });

    it('renders a PDF-only picker when only documentInputEnabled is true', () => {
      render(<ChatInterface agentSlug="my-agent" documentInputEnabled />);
      expect(screen.getByRole('button', { name: /attach a pdf/i })).toBeInTheDocument();
    });

    it('threads attachments into the chat POST body and clears input + picker', async () => {
      // Capture the request body so we can assert the attachments
      // array reached the endpoint. The stream resolves immediately so
      // we observe the post-send state.
      let captured: { attachments?: Array<{ name: string }>; message: string } | null = null;
      const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
        captured = init?.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          body: makeSseStream([startFrame('conv-1', 'msg-1'), contentFrame('ok'), doneFrame()]),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(URL, 'createObjectURL', {
        writable: true,
        value: vi.fn().mockReturnValue('blob:mock'),
      });
      Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() });

      const user = userEvent.setup();
      render(<ChatInterface agentSlug="my-agent" imageInputEnabled />);

      // Drop an image into the hidden file input.
      const fileInput = screen.getByTestId('attachment-picker-input');
      if (!(fileInput instanceof HTMLInputElement)) {
        throw new Error('Expected HTMLInputElement');
      }
      const file = new File(['fake-png-bytes'], 'photo.png', { type: 'image/png' });
      await user.upload(fileInput, file);

      // Wait for the picker to register the attachment.
      await waitFor(() => {
        expect(screen.getByTestId('attachment-thumbnail-strip')).toBeInTheDocument();
      });

      // Type a prompt and send.
      const textInput = screen.getByPlaceholderText(/type a message/i);
      await user.type(textInput, 'describe this');
      await user.click(screen.getByRole('button', { name: /^send$/i }));

      // The POST body should carry the attachments array with our file.
      await waitFor(() => {
        expect(captured?.attachments?.[0]?.name).toBe('photo.png');
        expect(captured?.message).toBe('describe this');
      });

      // Post-send: input cleared, thumbnail strip empty.
      await waitFor(() => {
        expect((textInput as HTMLInputElement).value).toBe('');
        expect(screen.queryByTestId('attachment-thumbnail-strip')).not.toBeInTheDocument();
      });
    });

    it('allows attachment-only sends (empty text + at least one attachment)', async () => {
      let captured: { attachments?: unknown; message: string } | null = null;
      const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
        captured = init?.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          body: makeSseStream([startFrame('conv-1', 'msg-1'), contentFrame('ack'), doneFrame()]),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(URL, 'createObjectURL', {
        writable: true,
        value: vi.fn().mockReturnValue('blob:mock'),
      });
      Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() });

      const user = userEvent.setup();
      render(<ChatInterface agentSlug="my-agent" imageInputEnabled />);

      const fileInput = screen.getByTestId('attachment-picker-input');
      if (!(fileInput instanceof HTMLInputElement)) {
        throw new Error('Expected HTMLInputElement');
      }
      await user.upload(fileInput, new File(['fake-png'], 'a.png', { type: 'image/png' }));
      await waitFor(() =>
        expect(screen.getByTestId('attachment-thumbnail-strip')).toBeInTheDocument()
      );

      // Send without typing anything.
      const send = screen.getByRole('button', { name: /^send$/i });
      expect(send).not.toBeDisabled();
      await user.click(send);

      await waitFor(() => {
        expect(captured?.message).toBe('');
        expect(Array.isArray(captured?.attachments)).toBe(true);
      });
    });

    it('keeps Send disabled when both text and attachments are empty', () => {
      render(<ChatInterface agentSlug="my-agent" imageInputEnabled />);
      const send = screen.getByRole('button', { name: /^send$/i });
      expect(send).toBeDisabled();
    });
  });

  // ─── localStorage persistence ──────────────────────────────────────────────
  //
  // The Test tab on the agent edit page persists its conversation per
  // agent so navigating tabs (or briefly leaving the page) doesn't
  // discard recent context. We exercise the persistence boundary
  // here: hydration, save-on-settle, TTL expiry, sanitisation of
  // approval cards, and the absent-key default.
  describe('localStorage persistence', () => {
    const KEY = 'agent-test-chat:agent-xyz';

    beforeEach(() => {
      window.localStorage.clear();
    });

    afterEach(() => {
      window.localStorage.clear();
    });

    it('rehydrates messages + conversationId from storage on mount', async () => {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          savedAt: Date.now(),
          conversationId: 'conv-restored',
          messages: [
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
          ],
        })
      );

      render(<ChatInterface agentSlug="my-agent" persistenceKey={KEY} />);

      // Hydration runs in a post-mount effect, so the restored
      // messages appear on the next render rather than synchronously.
      await waitFor(() => {
        expect(screen.getByText('earlier question')).toBeInTheDocument();
        expect(screen.getByText('earlier answer')).toBeInTheDocument();
      });
    });

    it('persists the conversation after a completed turn', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Hi back!'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(
        <ChatInterface agentSlug="my-agent" persistenceKey={KEY} enableTypingAnimation={false} />
      );

      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        const raw = window.localStorage.getItem(KEY);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string) as {
          conversationId: string | null;
          messages: Array<{ role: string; content: string }>;
        };
        expect(parsed.conversationId).toBe('conv-1');
        expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(parsed.messages[0].content).toBe('hello');
        expect(parsed.messages[1].content).toBe('Hi back!');
      });
    });

    it('discards a stored conversation older than the TTL', () => {
      const TWENTY_FIVE_HOURS = 25 * 60 * 60 * 1000;
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          savedAt: Date.now() - TWENTY_FIVE_HOURS,
          conversationId: 'conv-old',
          messages: [{ role: 'user', content: 'ancient question' }],
        })
      );

      render(<ChatInterface agentSlug="my-agent" persistenceKey={KEY} />);

      expect(screen.queryByText('ancient question')).not.toBeInTheDocument();
      // Stale blob is also pruned from storage so it doesn't linger.
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it('strips pendingApproval cards before persisting (workflow state lives server-side)', async () => {
      const user = userEvent.setup();
      const approval = {
        executionId: 'exec-1',
        stepId: 'step-approve',
        title: 'Approve this?',
        description: 'desc',
      };
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        approvalRequiredFrame(approval),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(
        <ChatInterface agentSlug="my-agent" persistenceKey={KEY} enableTypingAnimation={false} />
      );

      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'kick it off');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        const raw = window.localStorage.getItem(KEY);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string) as {
          messages: Array<Record<string, unknown>>;
        };
        // Approval card is not in the persisted payload …
        for (const msg of parsed.messages) {
          expect(msg.pendingApproval).toBeUndefined();
        }
        // … but the user turn that kicked it off is still there.
        expect(parsed.messages.some((m) => m.role === 'user' && m.content === 'kick it off')).toBe(
          true
        );
      });
    });

    it('does not touch localStorage when persistenceKey is not provided', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('reply'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');

      render(<ChatInterface agentSlug="my-agent" enableTypingAnimation={false} />);

      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByText('reply')).toBeInTheDocument();
      });

      // No reads or writes against the storage key namespace.
      const writes = setItemSpy.mock.calls.filter(([k]) =>
        String(k).startsWith('agent-test-chat:')
      );
      const reads = getItemSpy.mock.calls.filter(([k]) => String(k).startsWith('agent-test-chat:'));
      expect(writes).toHaveLength(0);
      expect(reads).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Message-input keyboard handling: Enter sends; Shift+Enter inserts a
  // newline so multi-line messages are composable in-place.
  // ──────────────────────────────────────────────────────────────────────

  describe('Message input keyboard handling', () => {
    it('renders the message input as a textarea (not a single-line input)', () => {
      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      expect(input.tagName).toBe('TEXTAREA');
    });

    it('sends on Enter without Shift', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([contentFrame('Pong')]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.click(input);
      await user.keyboard('Ping');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Ping')).toBeInTheDocument();
      });
    });

    it('inserts a newline on Shift+Enter rather than sending', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseStream([contentFrame('ignored')]),
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error(
          'Expected a textarea — see "renders the message input as a textarea" above'
        );
      }
      await user.click(input);
      await user.keyboard('Line one');
      await user.keyboard('{Shift>}{Enter}{/Shift}');
      await user.keyboard('Line two');

      // The textarea now contains a real newline and the send did not fire.
      expect(input.value).toBe('Line one\nLine two');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not send while an IME composition is in progress', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: makeSseStream([contentFrame('ignored')]),
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error(
          'Expected a textarea — see "renders the message input as a textarea" above'
        );
      }

      // Simulate an in-flight IME composition: typing a glyph and pressing
      // Enter to commit it. The browser dispatches keydown with
      // isComposing=true; if we treated that as "send", the
      // composition-confirmation keystroke would also fire the chat send.
      input.focus();
      input.value = 'こん';
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'isComposing', { value: true });
      input.dispatchEvent(event);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ─── Inline trace (admin diagnostic strip) ───────────────────────────────────

  describe('showInlineTrace', () => {
    function capabilityFrameWithTrace(
      slug: string,
      result: unknown,
      trace: Record<string, unknown>
    ): string {
      return `event: capability_result\ndata: ${JSON.stringify({ capabilitySlug: slug, result, trace })}\n\n`;
    }

    it('sends includeTrace: true on the POST body when enabled', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('hi'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
      expect(body.includeTrace).toBe(true);
    });

    it('omits includeTrace from the POST body by default', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('hi'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
      expect(body.includeTrace).toBeUndefined();
    });

    it('renders the MessageTrace strip when a trace-bearing capability_result arrives', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        capabilityFrameWithTrace(
          'search_knowledge_base',
          { success: true },
          {
            slug: 'search_knowledge_base',
            arguments: { query: 'reset password' },
            latencyMs: 215,
            success: true,
            resultPreview: '{"results":[]}',
          }
        ),
        contentFrame('Done.'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'help');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByTestId('message-trace')).toBeInTheDocument();
      });
      expect(screen.getByTestId('message-trace')).toHaveTextContent('1 tool');
      expect(screen.getByTestId('message-trace')).toHaveTextContent('215ms');
    });

    it('does not render the MessageTrace strip when showInlineTrace is false even if trace arrives', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        capabilityFrameWithTrace(
          'search_knowledge_base',
          { success: true },
          {
            slug: 'search_knowledge_base',
            arguments: {},
            latencyMs: 50,
            success: true,
          }
        ),
        contentFrame('Done.'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'help');
      await user.click(screen.getByRole('button', { name: /send/i }));

      // Wait for streaming to settle before asserting absence.
      await waitFor(() => {
        expect(screen.getByText('Done.')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('message-trace')).not.toBeInTheDocument();
    });

    it('aggregates traces from a parallel capability_results batch', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        `event: capability_results\ndata: ${JSON.stringify({
          results: [
            {
              capabilitySlug: 'a',
              result: { success: true },
              trace: { slug: 'a', arguments: {}, latencyMs: 30, success: true },
            },
            {
              capabilitySlug: 'b',
              result: { success: false, error: { code: 'oops', message: 'bad' } },
              trace: {
                slug: 'b',
                arguments: {},
                latencyMs: 30,
                success: false,
                errorCode: 'oops',
              },
            },
          ],
        })}\n\n`,
        contentFrame('All done.'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'help');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByTestId('message-trace')).toHaveTextContent('2 tools');
      });
      expect(screen.getByTestId('message-trace')).toHaveTextContent('1 failed');
    });
  });

  // ─── Cost / tokens / model meta strip ────────────────────────────────────────

  describe('cost row + input-breakdown toggle', () => {
    function doneFrameRich(opts: {
      tokens?: { input: number; output: number };
      cost?: number;
      model?: string;
      breakdown?: Record<string, unknown>;
    }): string {
      const payload: Record<string, unknown> = {};
      if (opts.tokens) {
        payload.tokenUsage = {
          inputTokens: opts.tokens.input,
          outputTokens: opts.tokens.output,
          totalTokens: opts.tokens.input + opts.tokens.output,
        };
      }
      if (typeof opts.cost === 'number') payload.costUsd = opts.cost;
      if (opts.model) payload.model = opts.model;
      if (opts.breakdown) payload.inputBreakdown = opts.breakdown;
      return `event: done\ndata: ${JSON.stringify(payload)}\n\n`;
    }

    const sampleBreakdown = {
      systemPrompt: { tokens: 120, chars: 480, content: 'You are helpful.' },
      userMessage: { tokens: 8, chars: 32, content: 'Hi' },
      framingOverhead: { tokens: 200, chars: 0 },
      totalEstimated: 328,
    };

    it('renders the cost / tokens / model summary line when showInlineTrace is on', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Done.'),
        doneFrameRich({
          tokens: { input: 4991, output: 234 },
          cost: 0.0123,
          model: 'gpt-4o-mini',
        }),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByText(/Toks:/)).toBeInTheDocument();
      });
      expect(screen.getByText(/4,991 input, 234 output/)).toBeInTheDocument();
      expect(screen.getByTitle('Approximate cost for this turn (main LLM only)')).toHaveTextContent(
        '$0.0123'
      );
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });

    it('formats sub-cent costs with four decimals and $1+ costs with two', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Done.'),
        doneFrameRich({ cost: 1.4567, tokens: { input: 100, output: 50 } }),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(
          screen.getByTitle('Approximate cost for this turn (main LLM only)')
        ).toHaveTextContent('$1.46');
      });
    });

    it('renders the cost row as a non-interactive div when no inputBreakdown is supplied', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Done.'),
        doneFrameRich({ tokens: { input: 100, output: 50 }, cost: 0.001 }),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByText(/Toks:/)).toBeInTheDocument();
      });
      // No "break down this turn's input tokens" button.
      expect(
        screen.queryByRole('button', { name: /break down this turn/i })
      ).not.toBeInTheDocument();
    });

    it('makes the cost row a toggle when inputBreakdown is present, and expands the panel on click', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Done.'),
        doneFrameRich({
          tokens: { input: 4991, output: 234 },
          cost: 0.0123,
          model: 'gpt-4o',
          breakdown: sampleBreakdown,
        }),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" showInlineTrace />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      // The toggle's accessible name is its body text (cost / tokens /
      // model). Match by the title attribute instead.
      const toggle = await screen.findByTitle(/break down this turn's input tokens/i);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // The breakdown list renders the framing row when expanded.
      expect(screen.getByText('Provider framing')).toBeInTheDocument();
      // Reconciliation header in the breakdown panel.
      expect(screen.getByText(/model reported 4,991/i)).toBeInTheDocument();
    });
  });

  // ─── Suggest-a-prompt button (suggestionPool) ────────────────────────────────

  describe('suggestionPool', () => {
    const POOL = ['Prompt A', 'Prompt B', 'Prompt C'];

    it('does not render the suggest button when the conversation is empty', () => {
      render(<ChatInterface agentSlug="test-agent" suggestionPool={POOL} />);
      expect(screen.queryByLabelText(/suggest a prompt/i)).not.toBeInTheDocument();
    });

    it('does not render the suggest button when the pool is empty', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Hi.'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" suggestionPool={[]} />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByText('Hi.')).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/suggest a prompt/i)).not.toBeInTheDocument();
    });

    it('renders the suggest button once a turn has been sent', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Hi.'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" suggestionPool={POOL} />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/suggest a prompt/i)).toBeInTheDocument();
      });
    });

    it('fills the input with a pool entry when the suggest button is clicked', async () => {
      // Pin Math.random so the test is deterministic about which
      // entry lands in the textarea. Other tests in this file run
      // under the real RNG; this one wraps and restores around the
      // click only.
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('Hi.'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(<ChatInterface agentSlug="test-agent" suggestionPool={POOL} />);
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hi');
      await user.click(screen.getByRole('button', { name: /send/i }));
      await waitFor(() => {
        expect(screen.getByLabelText(/suggest a prompt/i)).toBeInTheDocument();
      });

      // rng → 0 picks index 0 of the pool.
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        await user.click(screen.getByLabelText(/suggest a prompt/i));
        const textarea = screen.getByPlaceholderText(/type a message/i);
        if (!(textarea instanceof HTMLTextAreaElement)) {
          throw new Error('expected a textarea');
        }
        expect(textarea.value).toBe('Prompt A');
      } finally {
        rng.mockRestore();
      }
    });
  });

  // ─── Starter randomise button (onResampleStarters) ───────────────────────────

  describe('onResampleStarters', () => {
    it('does not render the shuffle button when the callback is absent', () => {
      render(<ChatInterface agentSlug="test-agent" starterPrompts={['A', 'B']} />);
      expect(screen.queryByLabelText(/randomise suggestions/i)).not.toBeInTheDocument();
    });

    it('renders the shuffle button when starters and the callback are present', () => {
      render(
        <ChatInterface
          agentSlug="test-agent"
          starterPrompts={['A', 'B']}
          onResampleStarters={() => {}}
        />
      );
      expect(screen.getByLabelText(/randomise suggestions/i)).toBeInTheDocument();
    });

    it('invokes the callback on click', async () => {
      const user = userEvent.setup();
      const onResample = vi.fn();
      render(
        <ChatInterface
          agentSlug="test-agent"
          starterPrompts={['A', 'B']}
          onResampleStarters={onResample}
        />
      );
      await user.click(screen.getByLabelText(/randomise suggestions/i));
      expect(onResample).toHaveBeenCalledOnce();
    });

    it('moves the shuffle button into the Suggested-prompts disclosure once the conversation starts', async () => {
      // Pre-conversation it lives next to "Try asking:"; post-first-turn
      // it relocates inside the disclosure (only visible when open) so
      // operators can still re-roll without scrolling back to the empty
      // state but the closed-disclosure header stays uncluttered.
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('hi'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      render(
        <ChatInterface
          agentSlug="test-agent"
          starterPrompts={['A', 'B']}
          onResampleStarters={() => {}}
        />
      );
      expect(screen.getByLabelText(/randomise suggestions/i)).toBeInTheDocument();
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));
      await waitFor(() => {
        // The pre-conversation grid is gone; the disclosure has taken over.
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
      // Disclosure starts closed — shuffle is hidden until the operator
      // opens it. Opening reveals exactly one shuffle button.
      expect(screen.queryByLabelText(/randomise suggestions/i)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(screen.getAllByLabelText(/randomise suggestions/i)).toHaveLength(1);
    });
  });

  // ─── Mid-conversation "Suggested prompts" disclosure ──────────────────────────

  describe('suggested prompts disclosure (post-first-turn)', () => {
    async function sendFirstTurn(user: ReturnType<typeof userEvent.setup>) {
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('hi'),
        doneFrame(),
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));
    }

    it('does not render the disclosure when no messages have been sent', () => {
      render(<ChatInterface agentSlug="test-agent" starterPrompts={['A', 'B']} />);
      expect(screen.queryByRole('button', { name: /suggested prompts/i })).not.toBeInTheDocument();
    });

    it('renders the disclosure header after the first turn', async () => {
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="test-agent" starterPrompts={['A', 'B']} />);
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
    });

    it('keeps the disclosure body hidden until the operator opens it', async () => {
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="test-agent" starterPrompts={['Alpha', 'Beta']} />);
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
      expect(screen.queryByTestId('suggested-prompts-panel')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      const panel = screen.getByTestId('suggested-prompts-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveTextContent('Alpha');
      expect(panel).toHaveTextContent('Beta');
    });

    it('sends a prompt and closes-on-send when the user clicks a suggestion inside the panel', async () => {
      const user = userEvent.setup();
      const stream = makeSseStream([
        startFrame('conv-1', 'msg-1'),
        contentFrame('hi'),
        doneFrame(),
      ]);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: stream });
      vi.stubGlobal('fetch', fetchMock);

      render(<ChatInterface agentSlug="test-agent" starterPrompts={['Alpha', 'Beta']} />);
      // First turn — sets messages.length > 0.
      const input = screen.getByPlaceholderText(/type a message/i);
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });

      // Open the disclosure and click a suggestion.
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      // Re-stub fetch for the second turn so the prompt click triggers
      // a fresh stream — the first stub is single-use (already drained).
      const stream2 = makeSseStream([
        startFrame('conv-1', 'msg-2'),
        contentFrame('ok'),
        doneFrame(),
      ]);
      fetchMock.mockResolvedValueOnce({ ok: true, body: stream2 });
      await user.click(screen.getByRole('button', { name: 'Alpha' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<
        string,
        unknown
      >;
      expect(second.message).toBe('Alpha');
    });

    it('shows the shuffle icon inside the disclosure when onResampleStarters is set', async () => {
      const user = userEvent.setup();
      const onResample = vi.fn();
      render(
        <ChatInterface
          agentSlug="test-agent"
          starterPrompts={['A', 'B']}
          onResampleStarters={onResample}
        />
      );
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
      // Shuffle is hidden while the disclosure is closed so the header
      // row stays uncluttered. Opening the disclosure also re-rolls
      // (onResample fires from the open gesture); a subsequent click on
      // the now-visible shuffle icon re-rolls again.
      expect(screen.queryByLabelText(/randomise suggestions/i)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(onResample).toHaveBeenCalledOnce();
      await user.click(screen.getByLabelText(/randomise suggestions/i));
      expect(onResample).toHaveBeenCalledTimes(2);
    });

    it('omits the shuffle icon when the caller has no resample handler (e.g. quiz)', async () => {
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="quiz-master" starterPrompts={['A', 'B']} />);
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/randomise suggestions/i)).not.toBeInTheDocument();
    });

    it('auto-randomises every time the user opens the disclosure', async () => {
      const user = userEvent.setup();
      const onResample = vi.fn();
      render(
        <ChatInterface
          agentSlug="test-agent"
          starterPrompts={['A', 'B']}
          onResampleStarters={onResample}
        />
      );
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });

      // First open → resample fires once.
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(onResample).toHaveBeenCalledTimes(1);

      // Close → no resample on collapse.
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(onResample).toHaveBeenCalledTimes(1);

      // Re-open → resamples again.
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(onResample).toHaveBeenCalledTimes(2);
    });

    it('does not throw when opening the disclosure without a resample handler', async () => {
      // Quiz path: no callback. The header still toggles the panel
      // open and the absence of `onResampleStarters` must not crash.
      const user = userEvent.setup();
      render(<ChatInterface agentSlug="quiz-master" starterPrompts={['A', 'B']} />);
      await sendFirstTurn(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggested prompts/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /suggested prompts/i }));
      expect(screen.getByTestId('suggested-prompts-panel')).toBeInTheDocument();
    });
  });
});
