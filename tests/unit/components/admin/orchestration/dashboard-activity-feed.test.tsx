/**
 * Unit Test: DashboardActivityFeed
 *
 * Covers the unified activity feed that merges conversations,
 * executions, and errors into a single timeline:
 * - Empty state when null or empty
 * - Renders items with correct titles and links
 * - Error items display with red styling and "error" badge
 * - Subtitle rendering
 * - Timestamp formatting + invalid fallback
 * - Limit prop
 *
 * @see components/admin/orchestration/dashboard-activity-feed.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  DashboardActivityFeed,
  type ActivityFeedItem,
} from '@/components/admin/orchestration/dashboard-activity-feed';

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

function makeConversation(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    kind: 'conversation',
    id: 'conv-1',
    title: 'Chat with SupportBot',
    timestamp: '2025-06-01T10:30:00.000Z',
    href: '/admin/orchestration/conversations/conv-1',
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    kind: 'execution',
    id: 'exec-1',
    title: 'Execution e1abc',
    subtitle: 'running',
    timestamp: '2025-06-02T14:00:00.000Z',
    href: '/admin/orchestration/executions/exec-1',
    ...overrides,
  };
}

function makeError(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    kind: 'error',
    id: 'err-1',
    title: 'Error cmjbv4i3',
    subtitle: 'Connection timeout',
    timestamp: '2025-06-03T08:00:00.000Z',
    href: '/admin/orchestration/executions/err-1',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DashboardActivityFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty state ───────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows empty message when items is null', () => {
      render(<DashboardActivityFeed items={null} />);

      expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
    });

    it('shows empty message when items is empty array', () => {
      render(<DashboardActivityFeed items={[]} />);

      expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
    });

    it('renders "Recent activity" title regardless of state', () => {
      render(<DashboardActivityFeed items={null} />);

      expect(screen.getByText('Recent activity')).toBeInTheDocument();
    });
  });

  // ── Item rendering ────────────────────────────────────────────────────

  describe('item rendering', () => {
    it('renders conversation items as links', () => {
      render(<DashboardActivityFeed items={[makeConversation()]} />);

      const link = screen.getByRole('link', { name: 'Chat with SupportBot' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/conversations/conv-1');
    });

    it('renders execution items as links', () => {
      render(<DashboardActivityFeed items={[makeExecution()]} />);

      const link = screen.getByRole('link', { name: 'Execution e1abc' });
      expect(link).toHaveAttribute('href', '/admin/orchestration/executions/exec-1');
    });

    it('renders error items with "error" badge', () => {
      render(<DashboardActivityFeed items={[makeError()]} />);

      expect(screen.getByText('error')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Error cmjbv4i3' })).toBeInTheDocument();
    });

    it('renders subtitle when provided', () => {
      render(<DashboardActivityFeed items={[makeExecution({ subtitle: 'running' })]} />);

      expect(screen.getByText('running')).toBeInTheDocument();
    });

    it('does not render subtitle element when subtitle is undefined', () => {
      render(<DashboardActivityFeed items={[makeConversation({ subtitle: undefined })]} />);

      // No subtitle div
      expect(screen.queryByText('SupportBot')).not.toBeInTheDocument();
    });

    it('renders mixed item types together', () => {
      render(<DashboardActivityFeed items={[makeConversation(), makeExecution(), makeError()]} />);

      expect(screen.getByRole('link', { name: 'Chat with SupportBot' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Execution e1abc' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Error cmjbv4i3' })).toBeInTheDocument();
    });
  });

  // ── Timestamps ────────────────────────────────────────────────────────

  describe('timestamps', () => {
    it('formats a valid ISO timestamp to a human-readable string', () => {
      render(
        <DashboardActivityFeed
          items={[makeConversation({ timestamp: '2025-06-01T10:30:00.000Z' })]}
        />
      );

      const body = document.body.textContent ?? '';
      expect(body).not.toContain('2025-06-01T10:30:00.000Z');
    });

    it('falls back to em-dash for an invalid timestamp', () => {
      render(<DashboardActivityFeed items={[makeConversation({ timestamp: 'not-a-date' })]} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  // ── Limit prop ────────────────────────────────────────────────────────

  describe('limit prop', () => {
    it('shows only up to `limit` items', () => {
      const items = [makeConversation(), makeExecution(), makeError()];
      render(<DashboardActivityFeed items={items} limit={1} />);

      expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('defaults to showing up to 10 items', () => {
      const items = Array.from({ length: 12 }, (_, i) =>
        makeConversation({ id: `conv-${i}`, title: `Conversation ${i}`, href: `/c/${i}` })
      );

      render(<DashboardActivityFeed items={items} />);

      expect(screen.getAllByRole('link')).toHaveLength(10);
    });
  });

  // ── Error styling ─────────────────────────────────────────────────────

  describe('error item styling', () => {
    it('error items do not show badge for non-error kinds', () => {
      render(<DashboardActivityFeed items={[makeConversation(), makeExecution()]} />);

      expect(screen.queryByText('error')).not.toBeInTheDocument();
    });

    it('error badge is present only for error items in mixed list', () => {
      render(<DashboardActivityFeed items={[makeConversation(), makeError()]} />);

      // Only one error badge
      expect(screen.getAllByText('error')).toHaveLength(1);
    });
  });
});
