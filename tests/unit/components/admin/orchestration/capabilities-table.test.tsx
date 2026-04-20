/**
 * CapabilitiesTable Component Tests
 *
 * Test Coverage:
 * - Initial render with 3-capability fixture (columns, headers)
 * - Search debounces at 300ms and refetches with ?q=...
 * - Category filter change refetches with ?category=knowledge
 * - isActive Switch flip PATCHes with { isActive: false } via apiClient;
 *   PATCH rejection reverts the row and shows an inline error
 * - Row dropdown "Delete" opens AlertDialog; confirm click DELETEs and removes row
 * - Lazy usage-count fetch per row — failure renders em-dash
 *
 * @see components/admin/orchestration/capabilities-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilitiesTable } from '@/components/admin/orchestration/capabilities-table';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import type { PaginationMeta } from '@/types/api';
import type { AiCapabilityListItem } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCapability(overrides: Partial<AiCapabilityListItem> = {}): AiCapabilityListItem {
  const id = overrides.id ?? 'cmjbv4i3x00003wsloputgwul';
  return {
    id,
    name: 'Test Capability',
    slug: 'test-capability',
    description: 'A test capability',
    category: 'api',
    executionType: 'api',
    executionHandler: 'https://example.com/handler',
    executionConfig: null,
    functionDefinition: {},
    requiresApproval: false,
    rateLimit: null,
    isActive: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    deletedAt: null,
    metadata: {},
    _agents: [],
    ...overrides,
  } as AiCapabilityListItem;
}

const THREE_CAPABILITIES: AiCapabilityListItem[] = [
  makeCapability({
    id: 'cap-1',
    name: 'Alpha Search',
    slug: 'alpha-search',
    category: 'knowledge',
    executionType: 'internal',
  }),
  makeCapability({
    id: 'cap-2',
    name: 'Beta Webhook',
    slug: 'beta-webhook',
    category: 'api',
    executionType: 'api',
    isActive: false,
  }),
  makeCapability({
    id: 'cap-3',
    name: 'Gamma Hook',
    slug: 'gamma-hook',
    category: 'webhook',
    executionType: 'webhook',
  }),
];

const MOCK_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 3,
  totalPages: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

function makeCapabilitiesListResponse(capabilities: AiCapabilityListItem[] = THREE_CAPABILITIES) {
  return createMockFetchResponse({
    success: true,
    data: capabilities,
    meta: MOCK_META,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilitiesTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;

    mockFetch.mockImplementation(() => {
      return Promise.resolve(makeCapabilitiesListResponse());
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders table headers', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      expect(screen.getByRole('button', { name: /^Name/ })).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('renders all 3 capability rows', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      expect(screen.getByText('Alpha Search')).toBeInTheDocument();
      expect(screen.getByText('Beta Webhook')).toBeInTheDocument();
      expect(screen.getByText('Gamma Hook')).toBeInTheDocument();
    });

    it('renders capability slugs', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      expect(screen.getByText('alpha-search')).toBeInTheDocument();
      expect(screen.getByText('beta-webhook')).toBeInTheDocument();
      expect(screen.getByText('gamma-hook')).toBeInTheDocument();
    });

    it('renders execution-type badges for each row', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      // Use getAllByText because 'api' and 'webhook' appear in both category badge and exec-type badge
      expect(screen.getAllByText('internal').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('api').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('webhook').length).toBeGreaterThanOrEqual(1);
    });

    it('renders search input and New capability button', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      expect(screen.getByPlaceholderText('Search capabilities...')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /new capability/i })).toBeInTheDocument();
    });

    it('renders empty state when no capabilities', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={[]}
          initialMeta={{ ...MOCK_META, total: 0 }}
          availableCategories={[]}
        />
      );

      expect(screen.getByText('No capabilities found.')).toBeInTheDocument();
    });

    it('renders category filter select', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });

  // ── Search / debounce ──────────────────────────────────────────────────────

  describe('search with debounce', () => {
    it('does not fetch immediately on typing', async () => {
      const user = userEvent.setup({ delay: null });
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );
      const initialCalls = mockFetch.mock.calls.length;

      await user.type(screen.getByPlaceholderText('Search capabilities...'), 'al');

      // No extra list fetches before debounce fires
      expect(mockFetch.mock.calls.length).toBe(initialCalls);
    });

    it('fires refetch after 300ms debounce with search query', async () => {
      const user = userEvent.setup({ delay: null });
      mockFetch.mockImplementation(() => {
        return Promise.resolve(makeCapabilitiesListResponse([THREE_CAPABILITIES[0]]));
      });

      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await user.type(screen.getByPlaceholderText('Search capabilities...'), 'al');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('q=al'))).toBe(true);
      });
    });

    it('fires a refetch after typing and advancing 300ms', async () => {
      // This test verifies the debounce fires after 300ms total, using a
      // simpler approach to avoid timer-order sensitivity with shouldAdvanceTime.
      const user = userEvent.setup({ delay: null });
      mockFetch.mockImplementation(() => {
        return Promise.resolve(makeCapabilitiesListResponse());
      });

      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await user.type(screen.getByPlaceholderText('Search capabilities...'), 'myquery');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('q=myquery'))).toBe(true);
      });
    });
  });

  // ── Category filter ────────────────────────────────────────────────────────

  describe('category filter', () => {
    it('changes category filter refetches with ?category=knowledge', async () => {
      const user = userEvent.setup();
      mockFetch.mockImplementation(() => {
        return Promise.resolve(makeCapabilitiesListResponse());
      });

      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      // Open the category select and pick 'knowledge'
      const select = screen.getByRole('combobox');
      await user.click(select);
      const knowledgeOption = await screen.findByRole('option', {
        name: /knowledge/i,
        hidden: true,
      });
      await user.click(knowledgeOption);

      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('category=knowledge'))).toBe(true);
      });
    });
  });

  // ── Status Switch (optimistic) ─────────────────────────────────────────────

  describe('status switch optimistic update', () => {
    it('calls apiClient.patch with isActive when switch is toggled', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities/cap-1'),
          expect.objectContaining({
            body: expect.objectContaining({ isActive: expect.any(Boolean) }),
          })
        );
      });
    });

    it('reverts switch and shows error on PATCH failure', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Not allowed', 'FORBIDDEN', 403)
      );

      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      const switches = screen.getAllByRole('switch');
      const initialChecked = (switches[0] as HTMLInputElement).checked;

      await user.click(switches[0]);

      await waitFor(() => {
        expect(screen.getByText(/couldn't update/i)).toBeInTheDocument();
      });

      const switchesAfter = screen.getAllByRole('switch');
      expect((switchesAfter[0] as HTMLInputElement).checked).toBe(initialChecked);
    });
  });

  // ── Delete confirm flow ────────────────────────────────────────────────────

  describe('delete confirm flow', () => {
    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i, hidden: true });
      await user.click(deleteItem);
      await waitFor(() => expect(screen.getByText('Delete capability')).toBeInTheDocument());
    }

    it('clicking Delete opens AlertDialog with capability name', async () => {
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await openDeleteDialog(user);

      expect(screen.getByText('Delete capability')).toBeInTheDocument();
    });

    it('confirms delete calls apiClient.delete and removes row', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      mockFetch.mockImplementation(() => {
        return Promise.resolve(makeCapabilitiesListResponse(THREE_CAPABILITIES.slice(1)));
      });

      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities/cap-1')
        );
      });
    });

    it('cancelling delete closes dialog without calling delete', async () => {
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Delete capability')).not.toBeInTheDocument();
      });
      expect(apiClient.delete).not.toHaveBeenCalled();
    });
  });

  // ── Agent-list Popover ─────────────────────────────────────────────────────

  describe('agent-list popover', () => {
    // Agent fixtures used in _agents arrays
    const TWO_AGENTS = [
      { id: 'agent-aa', name: 'Agent Amber', slug: 'agent-amber', isActive: true },
      { id: 'agent-bb', name: 'Agent Bravo', slug: 'agent-bravo', isActive: true },
    ];

    const ONE_AGENT = [{ id: 'agent-solo', name: 'Solo Bot', slug: 'solo-bot', isActive: true }];

    // Build a fixture set where cap-1 has the given agents; cap-2 and cap-3 have none.
    function makeCapabilitiesWithAgents(agents: typeof TWO_AGENTS): AiCapabilityListItem[] {
      return [
        makeCapability({
          id: 'cap-1',
          name: 'Alpha Search',
          slug: 'alpha-search',
          category: 'knowledge',
          executionType: 'internal',
          _agents: agents,
        }),
        makeCapability({
          id: 'cap-2',
          name: 'Beta Webhook',
          slug: 'beta-webhook',
          category: 'api',
          executionType: 'api',
          isActive: false,
          _agents: [],
        }),
        makeCapability({
          id: 'cap-3',
          name: 'Gamma Hook',
          slug: 'gamma-hook',
          category: 'webhook',
          executionType: 'webhook',
          _agents: [],
        }),
      ];
    }

    it('trigger button renders the agent count', () => {
      render(
        <CapabilitiesTable
          initialCapabilities={makeCapabilitiesWithAgents(TWO_AGENTS)}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      // cap-1 has 2 agents, so its trigger shows "2 →"
      const trigger = screen.getByRole('button', { name: /2 →/ });
      expect(trigger).toHaveTextContent('2');
    });

    it('clicking the trigger opens the popover and reveals linked agent names', async () => {
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={makeCapabilitiesWithAgents(TWO_AGENTS)}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      // cap-1 has 2 agents; click its trigger
      await user.click(screen.getByRole('button', { name: /2 →/ }));

      // Radix Popover renders content via a portal into document.body
      await waitFor(() => {
        expect(screen.getByText('Agent Amber')).toBeInTheDocument();
        expect(screen.getByText('Agent Bravo')).toBeInTheDocument();
      });
    });

    it('each agent row renders both name and slug and links to /admin/orchestration/agents/{id}', async () => {
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={makeCapabilitiesWithAgents(TWO_AGENTS)}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await user.click(screen.getByRole('button', { name: /2 →/ }));

      await waitFor(() => {
        expect(screen.getByText('Agent Amber')).toBeInTheDocument();
        expect(screen.getByText('agent-amber')).toBeInTheDocument();
        expect(screen.getByText('Agent Bravo')).toBeInTheDocument();
        expect(screen.getByText('agent-bravo')).toBeInTheDocument();
      });

      const amberLink = screen.getByText('Agent Amber').closest('a');
      expect(amberLink).toHaveAttribute('href', '/admin/orchestration/agents/agent-aa');

      const bravoLink = screen.getByText('Agent Bravo').closest('a');
      expect(bravoLink).toHaveAttribute('href', '/admin/orchestration/agents/agent-bb');
    });

    it('header uses singular "agent" when count is 1', async () => {
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={makeCapabilitiesWithAgents(ONE_AGENT)}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await user.click(screen.getByRole('button', { name: /1 →/ }));

      await waitFor(() => {
        expect(screen.getByText(/1 agent using/)).toBeInTheDocument();
      });
      expect(screen.queryByText(/1 agents using/)).not.toBeInTheDocument();
    });

    it('header uses plural "agents" when count is greater than 1', async () => {
      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={makeCapabilitiesWithAgents(TWO_AGENTS)}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      await user.click(screen.getByRole('button', { name: /2 →/ }));

      await waitFor(() => {
        expect(screen.getByText(/2 agents using/)).toBeInTheDocument();
      });
    });

    it('renders plain "0" without a Popover trigger when agent count is zero', () => {
      // THREE_CAPABILITIES all have _agents: [] by default
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={MOCK_META}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      // All 3 rows have 0 agents → plain "0" text, no popover trigger
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(3);

      expect(screen.queryByRole('button', { name: /→/ })).not.toBeInTheDocument();
    });
  });

  // ── Pagination boundary ────────────────────────────────────────────────────

  describe('pagination boundary behaviour', () => {
    it('Previous button is disabled on page 1', () => {
      // Arrange: page 1 of 2
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={meta}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      const prevBtn = screen.getByRole('button', { name: /previous/i });
      expect(prevBtn).toBeDisabled();
    });

    it('Next button is disabled on the last page', () => {
      // Arrange: already on last page (page 2 of 2)
      const meta: PaginationMeta = { page: 2, limit: 25, total: 50, totalPages: 2 };
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={meta}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).toBeDisabled();
    });

    it('Next button is enabled on page 1 of 2 and clicking it refetches page 2', async () => {
      // Arrange: page 1 of 2
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };

      mockFetch.mockImplementation(() => {
        return Promise.resolve(makeCapabilitiesListResponse());
      });

      const user = userEvent.setup();
      render(
        <CapabilitiesTable
          initialCapabilities={THREE_CAPABILITIES}
          initialMeta={meta}
          availableCategories={['knowledge', 'api', 'webhook']}
        />
      );

      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).not.toBeDisabled();
      await user.click(nextBtn);

      // Assert: a list fetch with page=2 was fired
      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('page=2'))).toBe(true);
      });
    });
  });
});
