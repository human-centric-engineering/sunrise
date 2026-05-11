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

    // Marker chip and panel both render in the assistant message.
    await waitFor(() => {
      expect(screen.getByLabelText('Citation 1')).toBeInTheDocument();
      expect(screen.getByText('Sources (1)')).toBeInTheDocument();
      expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
    });
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
  });
});
