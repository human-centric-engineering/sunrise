/**
 * WebhooksTable Tests
 *
 * Test Coverage:
 * - Renders webhook rows with URL, events, and status
 * - Shows empty state when no webhooks
 * - Create button links to new webhook page
 *
 * @see components/admin/orchestration/webhooks-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import {
  WebhooksTable,
  type WebhookListItem,
} from '@/components/admin/orchestration/webhooks-table';
import type { PaginationMeta } from '@/types/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock global fetch to prevent real network calls from useEffect
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () =>
    Promise.resolve({
      success: true,
      data: [],
      meta: { page: 1, limit: 25, total: 0, totalPages: 1 },
    }),
});
vi.stubGlobal('fetch', mockFetch);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

const MOCK_WEBHOOKS: WebhookListItem[] = [
  {
    id: 'wh-1',
    url: 'https://example.com/hooks/sunrise',
    events: ['budget_exceeded', 'workflow_failed'],
    isActive: true,
    description: 'Slack alerts',
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
  },
  {
    id: 'wh-2',
    url: 'https://other.com/webhook',
    events: ['message_created'],
    isActive: false,
    description: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhooksTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders webhook rows', () => {
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/other\.com/)).toBeInTheDocument();
    expect(screen.getByText('Slack alerts')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('shows empty state when no webhooks', async () => {
    render(<WebhooksTable initialWebhooks={[]} initialMeta={META} />);

    // The useEffect fetch runs on mount; wait for it to settle
    await waitFor(() => {
      expect(screen.getByText(/no webhook subscriptions yet/i)).toBeInTheDocument();
    });
  });

  it('has a create button linking to new webhook page', () => {
    render(<WebhooksTable initialWebhooks={[]} initialMeta={META} />);

    const link = screen.getByRole('link', { name: /new webhook/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration/webhooks/new');
  });

  it('renders event badges for each webhook', () => {
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    expect(screen.getByText('budget_exceeded')).toBeInTheDocument();
    expect(screen.getByText('workflow_failed')).toBeInTheDocument();
    expect(screen.getByText('message_created')).toBeInTheDocument();
  });
});
