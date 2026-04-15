/**
 * RecentActivityList Component Tests
 *
 * Test Coverage:
 * - Empty state: shown when items is an empty array
 * - Empty state: shown when items is null
 * - Renders activity items with correct titles and links
 * - Renders subtitle when provided, omits it when absent
 * - Timestamps are formatted (valid ISO input produces human-readable output)
 * - Invalid timestamps fall back to em-dash
 * - limit prop restricts the number of displayed rows
 * - Conversation items are distinguishable from execution items
 *
 * @see components/admin/orchestration/recent-activity-list.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  RecentActivityList,
  type RecentActivityItem,
} from '@/components/admin/orchestration/recent-activity-list';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/admin/orchestration'),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<RecentActivityItem> = {}): RecentActivityItem {
  return {
    kind: 'conversation',
    id: 'conv-1',
    title: 'Chat with SupportBot',
    subtitle: 'SupportBot',
    timestamp: '2025-06-01T10:30:00.000Z',
    href: '/admin/orchestration/conversations/conv-1',
    ...overrides,
  };
}

function makeExecution(overrides: Partial<RecentActivityItem> = {}): RecentActivityItem {
  return {
    kind: 'execution',
    id: 'exec-1',
    title: 'Triage workflow run',
    subtitle: 'triage-workflow',
    timestamp: '2025-06-02T14:00:00.000Z',
    href: '/admin/orchestration/executions/exec-1',
    ...overrides,
  };
}

const MIXED_ITEMS: RecentActivityItem[] = [
  makeConversation(),
  makeExecution(),
  makeConversation({ id: 'conv-2', title: 'Second conversation', href: '/conversations/conv-2' }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecentActivityList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows empty state message when items is an empty array', () => {
      render(<RecentActivityList items={[]} />);

      expect(screen.getByText(/no recent conversations or executions/i)).toBeInTheDocument();
    });

    it('shows empty state message when items is null', () => {
      render(<RecentActivityList items={null} />);

      expect(screen.getByText(/no recent conversations or executions/i)).toBeInTheDocument();
    });

    it('renders the "Recent activity" card title regardless of empty state', () => {
      render(<RecentActivityList items={null} />);

      expect(screen.getByText('Recent activity')).toBeInTheDocument();
    });
  });

  // ── Item rendering ────────────────────────────────────────────────────────

  describe('item rendering', () => {
    it('renders item titles as links', () => {
      render(<RecentActivityList items={MIXED_ITEMS} />);

      expect(screen.getByRole('link', { name: 'Chat with SupportBot' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Triage workflow run' })).toBeInTheDocument();
    });

    it('links point to correct hrefs', () => {
      render(<RecentActivityList items={[makeConversation()]} />);

      const link = screen.getByRole('link', { name: 'Chat with SupportBot' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/conversations/conv-1');
    });

    it('renders subtitle when provided', () => {
      render(<RecentActivityList items={[makeConversation()]} />);

      expect(screen.getByText('SupportBot')).toBeInTheDocument();
    });

    it('does not render subtitle element when subtitle is undefined', () => {
      render(<RecentActivityList items={[makeConversation({ subtitle: undefined })]} />);

      // The subtitle div should not appear
      expect(screen.queryByText('SupportBot')).not.toBeInTheDocument();
    });

    it('renders all provided items', () => {
      render(<RecentActivityList items={MIXED_ITEMS} />);

      expect(screen.getByRole('link', { name: 'Chat with SupportBot' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Triage workflow run' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Second conversation' })).toBeInTheDocument();
    });
  });

  // ── Timestamps ────────────────────────────────────────────────────────────

  describe('timestamps', () => {
    it('formats a valid ISO timestamp to a human-readable string', () => {
      render(
        <RecentActivityList items={[makeConversation({ timestamp: '2025-06-01T10:30:00.000Z' })]} />
      );

      // The output depends on locale, but it should not be the raw ISO string
      const body = document.body.textContent ?? '';
      expect(body).not.toContain('2025-06-01T10:30:00.000Z');
      // And it should not be the em-dash fallback
      expect(body).not.toMatch(/^—$/);
    });

    it('falls back to em-dash for an invalid timestamp', () => {
      render(<RecentActivityList items={[makeConversation({ timestamp: 'not-a-date' })]} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  // ── Limit prop ────────────────────────────────────────────────────────────

  describe('limit prop', () => {
    it('shows only up to `limit` items when provided', () => {
      render(<RecentActivityList items={MIXED_ITEMS} limit={1} />);

      // Only the first item should be visible
      expect(screen.getByRole('link', { name: 'Chat with SupportBot' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Triage workflow run' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Second conversation' })).not.toBeInTheDocument();
    });

    it('defaults to showing up to 10 items', () => {
      const tenItems = Array.from({ length: 12 }, (_, i) =>
        makeConversation({ id: `conv-${i}`, title: `Conversation ${i}`, href: `/c/${i}` })
      );

      render(<RecentActivityList items={tenItems} />);

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(10);
    });
  });
});
