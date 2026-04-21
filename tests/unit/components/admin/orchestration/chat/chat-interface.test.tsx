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

    await waitFor(() => {
      // getUserFacingError('internal_error') → title: 'Something Went Wrong'
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

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

    await waitFor(() => {
      // getUserFacingError('stream_error') → title: 'Something Went Wrong'
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    // User message should still be visible, but the empty assistant message should be removed
    expect(screen.getByText('Hi')).toBeInTheDocument();
    // There should be exactly one message bubble (the user's), not two
    const messageBubbles = document.querySelectorAll('.rounded-lg.px-3.py-2');
    expect(messageBubbles).toHaveLength(1);
  });

  it('shows rate limit error on 429 response', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, body: null }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      // getUserFacingError('rate_limited') → title: 'Too Many Requests'
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
  });

  it('shows error when res.body is null despite res.ok', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));

    render(<ChatInterface agentSlug="test-agent" />);

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'Hi');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      // getUserFacingError('stream_error') → title: 'Something Went Wrong'
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });
});
