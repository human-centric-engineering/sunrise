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
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// Mock global fetch — returns the MOCK_WEBHOOKS fixture by default so
// the useEffect re-fetch on mount doesn't clear the initial data.
const mockFetch = vi.fn();
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
    _count: { deliveries: 12 },
  },
  {
    id: 'wh-2',
    url: 'https://other.com/webhook',
    events: ['message_created'],
    isActive: false,
    description: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    _count: { deliveries: 0 },
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhooksTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: MOCK_WEBHOOKS,
          meta: { page: 1, limit: 25, total: 2, totalPages: 1 },
        }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders webhook rows with URL, description, and delivery count', () => {
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/other\.com/)).toBeInTheDocument();
    expect(screen.getByText('Slack alerts')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    // Active toggles rendered as switches
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
  });

  it('shows empty state when no webhooks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [],
          meta: { page: 1, limit: 25, total: 0, totalPages: 1 },
        }),
    });
    render(<WebhooksTable initialWebhooks={[]} initialMeta={META} />);

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

  it('row actions dropdown contains Edit and Delete', async () => {
    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
    await user.click(actionBtns[0]);

    expect(await screen.findByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('toggling active switch calls apiClient.patch', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

    const userEvent = await import('@testing-library/user-event');
    const user = userEvent.default.setup();
    render(
      <WebhooksTable
        initialWebhooks={MOCK_WEBHOOKS}
        initialMeta={{ ...META, total: 2, totalPages: 1 }}
      />
    );

    const switches = screen.getAllByRole('switch');
    await user.click(switches[0]);

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('/webhooks/wh-1'),
        expect.objectContaining({ body: { isActive: false } })
      );
    });
  });
});
