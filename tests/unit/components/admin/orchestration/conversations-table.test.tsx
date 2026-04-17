/**
 * ConversationsTable Component Tests
 *
 * Test Coverage:
 * - Renders initial conversations passed as props
 * - "Untitled" fallback for conversations with null title
 * - Agent name column shows "—" when no agent
 * - Message count column renders
 * - Active / Inactive status badges
 * - Empty state: "No conversations found"
 * - Search input updates placeholder based on message-search toggle
 * - Error banner shown on failed fetch
 * - Pagination: prev/next buttons only visible when totalPages > 1
 * - Prev button disabled on first page; next disabled on last page
 *
 * @see components/admin/orchestration/conversations-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConversationsTable } from '@/components/admin/orchestration/conversations-table';
import type { PaginationMeta } from '@/types/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<PaginationMeta> = {}): PaginationMeta {
  return {
    page: 1,
    limit: 20,
    total: 2,
    totalPages: 1,
    ...overrides,
  };
}

const AGENTS = [
  { id: 'agent-1', name: 'Support Bot' },
  { id: 'agent-2', name: 'Sales Bot' },
];

const CONVERSATIONS = [
  {
    id: 'conv-1',
    title: 'Refund request',
    isActive: true,
    agentId: 'agent-1',
    agent: { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' },
    _count: { messages: 7 },
    createdAt: '2025-03-01T10:00:00Z',
    updatedAt: '2025-03-02T12:00:00Z',
  },
  {
    id: 'conv-2',
    title: null,
    isActive: false,
    agentId: null,
    agent: null,
    _count: { messages: 0 },
    createdAt: '2025-03-03T10:00:00Z',
    updatedAt: '2025-03-03T10:00:00Z',
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [],
          meta: makeMeta(),
        }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic rendering ────────────────────────────────────────────────────────

  it('renders conversation titles from initial data', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('Refund request')).toBeInTheDocument();
  });

  it('shows "Untitled" for conversations with null title', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('Untitled')).toBeInTheDocument();
  });

  it('shows agent name in agent column', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('Support Bot')).toBeInTheDocument();
  });

  it('shows em-dash when conversation has no agent', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    // The second conversation has null agent
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders message count column', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('shows Active and Inactive badges', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ total: 2 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows empty state message when no conversations', () => {
    render(
      <ConversationsTable
        initialConversations={[]}
        initialMeta={makeMeta({ total: 0 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText('No conversations found.')).toBeInTheDocument();
  });

  // ── Table headers ──────────────────────────────────────────────────────────

  it('renders table headers', () => {
    render(<ConversationsTable initialConversations={[]} initialMeta={makeMeta()} agents={[]} />);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  // ── Search input ───────────────────────────────────────────────────────────

  it('renders search input with default placeholder', () => {
    render(<ConversationsTable initialConversations={[]} initialMeta={makeMeta()} agents={[]} />);

    expect(screen.getByPlaceholderText('Search by title…')).toBeInTheDocument();
  });

  it('placeholder changes to message content search when toggle is checked', async () => {
    const user = userEvent.setup();
    render(<ConversationsTable initialConversations={[]} initialMeta={makeMeta()} agents={[]} />);

    const checkbox = screen.getByRole('checkbox', { name: /search messages/i });
    await user.click(checkbox);

    expect(screen.getByPlaceholderText('Search message content…')).toBeInTheDocument();
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows error banner when fetch fails', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ ok: false });

    render(<ConversationsTable initialConversations={[]} initialMeta={makeMeta()} agents={[]} />);

    // Trigger a fetch via search
    const input = screen.getByPlaceholderText('Search by title…');
    await user.type(input, 'test');

    await waitFor(
      () => {
        expect(
          screen.getByText('Could not load conversations. Try refreshing the page.')
        ).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  it('does not show pagination when totalPages is 1', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ totalPages: 1 })}
        agents={AGENTS}
      />
    );

    expect(screen.queryByRole('button', { name: /previous/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('shows pagination controls when totalPages > 1', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ page: 1, totalPages: 3, total: 60 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('previous button is disabled on first page', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ page: 1, totalPages: 3, total: 60 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });

  it('next button is disabled on last page', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ page: 3, totalPages: 3, total: 60 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('shows page info text when paginating', () => {
    render(
      <ConversationsTable
        initialConversations={CONVERSATIONS}
        initialMeta={makeMeta({ page: 2, totalPages: 5, total: 100 })}
        agents={AGENTS}
      />
    );

    expect(screen.getByText(/page 2 of 5/i)).toBeInTheDocument();
  });
});
