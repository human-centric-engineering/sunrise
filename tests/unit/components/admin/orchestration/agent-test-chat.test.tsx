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
    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    // Assert: raw secret never reaches DOM
    expect(document.body.textContent ?? '').not.toContain(SECRET);
  });

  it('renders budget_exceeded error with specific message', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([errorFrame('budget_exceeded')]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/monthly budget reached/i)).toBeInTheDocument();
    });
  });

  it('renders warning banner from warning event', async () => {
    const user = userEvent.setup();
    const stream = makeSseStream([
      warningFrame('budget_warning', 'Agent at 85% budget'),
      contentFrame('Hello'),
      'event: done\ndata: {"tokenUsage":{"inputTokens":10,"outputTokens":5,"totalTokens":15},"costUsd":0.001}\n\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/agent at 85% budget/i)).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });
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

  it('shows connection lost error immediately on network failure (no retry)', async () => {
    // Arrange — fetch rejects; chat POSTs are not idempotent so no retry
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<AgentTestChat agentSlug="my-agent" initialMessage="Hi" />);

    // Act
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    // Assert — error shown immediately without reconnect attempts
    await waitFor(() => {
      expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
      expect(screen.getByText(/chat stream was interrupted/i)).toBeInTheDocument();
    });

    // Assert — fetch was only called once (no retries)
    expect(fetch).toHaveBeenCalledOnce();
  });
});
