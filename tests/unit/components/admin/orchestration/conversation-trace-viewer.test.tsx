/**
 * Unit Test: ConversationTraceViewer
 *
 * @see components/admin/orchestration/conversation-trace-viewer.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationTraceViewer,
  type ConversationMessage,
} from '@/components/admin/orchestration/conversation-trace-viewer';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_MESSAGE: ConversationMessage = {
  id: 'msg-1',
  role: 'user',
  content: 'Hello there',
  capabilitySlug: null,
  toolCallId: null,
  metadata: null,
  createdAt: '2025-01-01T10:00:00.000Z',
};

function makeMessage(overrides: Partial<ConversationMessage>): ConversationMessage {
  return { ...BASE_MESSAGE, ...overrides };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationTraceViewer', () => {
  describe('Empty state', () => {
    it('shows "No messages in this conversation." when messages is empty', () => {
      render(<ConversationTraceViewer messages={[]} />);

      expect(screen.getByText('No messages in this conversation.')).toBeInTheDocument();
    });
  });

  describe('Summary bar', () => {
    it('renders summary cards with correct message count', () => {
      const messages = [
        makeMessage({ id: 'msg-1' }),
        makeMessage({ id: 'msg-2' }),
        makeMessage({ id: 'msg-3' }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      // The Messages card shows the total count
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('calculates total tokens from metadata', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          metadata: {
            tokenUsage: { input: 100, output: 50 },
          },
        }),
        makeMessage({
          id: 'msg-2',
          metadata: {
            tokenUsage: { input: 200, output: 80 },
          },
        }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      // 100+50+200+80 = 430 tokens
      expect(screen.getByText('430')).toBeInTheDocument();
    });

    it('calculates total cost from metadata', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          metadata: { costUsd: 0.01 },
        }),
        makeMessage({
          id: 'msg-2',
          metadata: { costUsd: 0.005 },
        }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      // 0.01 + 0.005 = 0.015 → "$0.0150"
      expect(screen.getByText('$0.0150')).toBeInTheDocument();
    });

    it('shows em-dash for avg latency when no messages have latency', () => {
      render(<ConversationTraceViewer messages={[makeMessage({ id: 'msg-1' })]} />);

      // SummaryBar Avg Latency card should show "—"
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('calculates average latency from messages with latencyMs', () => {
      const messages = [
        makeMessage({ id: 'msg-1', metadata: { latencyMs: 200 } }),
        makeMessage({ id: 'msg-2', metadata: { latencyMs: 400 } }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      // avg(200, 400) = 300
      expect(screen.getByText('300 ms')).toBeInTheDocument();
    });
  });

  describe('Message cards', () => {
    it('renders a card for each message', () => {
      const messages = [
        makeMessage({ id: 'msg-1' }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hi!' }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      expect(screen.getByTestId('message-msg-1')).toBeInTheDocument();
      expect(screen.getByTestId('message-msg-2')).toBeInTheDocument();
    });

    it('shows role badges for user and assistant messages', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user' }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Reply' }),
      ];
      render(<ConversationTraceViewer messages={messages} />);

      expect(screen.getByText('User')).toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('shows Tool badge for tool messages', () => {
      render(
        <ConversationTraceViewer
          messages={[makeMessage({ id: 'msg-1', role: 'tool', content: '{"result":"ok"}' })]}
        />
      );

      expect(screen.getByText('Tool')).toBeInTheDocument();
    });

    it('shows capability slug for tool messages', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'tool',
              content: '{"result":"ok"}',
              capabilitySlug: 'web-search',
            }),
          ]}
        />
      );

      expect(screen.getByText('web-search')).toBeInTheDocument();
    });

    it('does not show capability slug for non-tool messages', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'user',
              capabilitySlug: 'web-search', // ignored for non-tool
            }),
          ]}
        />
      );

      expect(screen.queryByText('web-search')).not.toBeInTheDocument();
    });
  });

  describe('Message metadata display', () => {
    it('shows model name when present in metadata', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              metadata: { modelUsed: 'claude-sonnet-4-6' },
            }),
          ]}
        />
      );

      expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    });

    it('shows token counts when present in metadata', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              metadata: { tokenUsage: { input: 150, output: 75 } },
            }),
          ]}
        />
      );

      expect(screen.getByText('150 in')).toBeInTheDocument();
      expect(screen.getByText('75 out')).toBeInTheDocument();
    });

    it('shows latency when present in metadata', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              metadata: { latencyMs: 350 },
            }),
          ]}
        />
      );

      // "350 ms" appears in both the SummaryBar avg latency card and the message
      // metadata bar — getAllByText confirms it is rendered at least once.
      expect(screen.getAllByText('350 ms').length).toBeGreaterThanOrEqual(1);
    });

    it('shows cost when present in metadata', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              metadata: { costUsd: 0.0042 },
            }),
          ]}
        />
      );

      // "$0.0042" appears in both the SummaryBar total cost card and the message
      // metadata bar — getAllByText confirms it is rendered at least once.
      expect(screen.getAllByText('$0.0042').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Raw toggle', () => {
    it('shows "Raw" button for messages with metadata', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              metadata: { modelUsed: 'claude-sonnet-4-6' },
            }),
          ]}
        />
      );

      expect(screen.getByRole('button', { name: /raw/i })).toBeInTheDocument();
    });

    it('does not show "Raw" button for messages without metadata', () => {
      render(<ConversationTraceViewer messages={[makeMessage({ id: 'msg-1', metadata: null })]} />);

      expect(screen.queryByRole('button', { name: /raw/i })).not.toBeInTheDocument();
    });

    it('reveals full metadata JSON when Raw toggle is clicked', async () => {
      const user = userEvent.setup();
      const meta = { modelUsed: 'claude-sonnet-4-6', latencyMs: 200 };

      render(
        <ConversationTraceViewer
          messages={[makeMessage({ id: 'msg-1', role: 'assistant', metadata: meta })]}
        />
      );

      // Metadata JSON not visible initially
      expect(screen.queryByText(/"modelUsed"/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /raw/i }));

      // JSON should now be visible in a pre element
      expect(screen.getByText(/"modelUsed"/)).toBeInTheDocument();
    });

    it('hides metadata JSON when Raw toggle is clicked again (toggle off)', async () => {
      const user = userEvent.setup();
      const meta = { modelUsed: 'claude-sonnet-4-6' };

      render(
        <ConversationTraceViewer
          messages={[makeMessage({ id: 'msg-1', role: 'assistant', metadata: meta })]}
        />
      );

      const button = screen.getByRole('button', { name: /raw/i });

      await user.click(button);
      expect(screen.getByText(/"modelUsed"/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /hide raw/i }));
      expect(screen.queryByText(/"modelUsed"/)).not.toBeInTheDocument();
    });
  });

  describe('Citations rehydration', () => {
    it('renders the sources panel and marker links from persisted metadata.citations', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              content: 'The deposit must be protected within 30 days [1].',
              metadata: {
                citations: [
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
                ],
              },
            }),
          ]}
        />
      );

      expect(screen.getByLabelText('Citation 1')).toHaveAttribute('href', '#citation-1');
      expect(screen.getByText('Sources (1)')).toBeInTheDocument();
      expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
      expect(screen.getByText(/within 30 days of receipt/)).toBeInTheDocument();
    });

    it('does not render a sources panel when metadata.citations is absent', () => {
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              content: 'A general-knowledge answer with no retrieval.',
              metadata: { modelUsed: 'claude-sonnet-4-6' },
            }),
          ]}
        />
      );

      expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
    });

    it('degrades gracefully when persisted citations are malformed', () => {
      // safeParse on the strict messageMetadataSchema fails for the
      // whole metadata object when any field is the wrong shape — the
      // trace viewer must still render the message text rather than
      // throwing or showing a broken panel.
      render(
        <ConversationTraceViewer
          messages={[
            makeMessage({
              id: 'msg-1',
              role: 'assistant',
              content: 'Answer body.',
              metadata: {
                citations: [
                  {
                    // marker should be a number — pin a string here to
                    // simulate a corrupt persisted entry from a future
                    // schema migration or an out-of-band write.
                    marker: 'one',
                    chunkId: 'c1',
                    documentId: 'd1',
                    documentName: 'X',
                    section: null,
                    patternNumber: null,
                    patternName: null,
                    excerpt: 'corrupt',
                    similarity: 0.5,
                  },
                ],
              },
            }),
          ]}
        />
      );

      expect(screen.getByText('Answer body.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
    });
  });
});
