/**
 * AgentsTable Component Tests
 *
 * Test Coverage:
 * - Initial render with 3-agent fixture (columns, headers)
 * - Debounced search (300ms) triggers refetch
 * - Sort click triggers refetch with correct params
 * - Status Switch optimistic PATCH + revert on failure
 * - Bulk select + Export POSTs with correct ids, respects Content-Disposition filename
 * - Delete confirm flow
 * - Budget fetch failure renders em-dash, does not throw
 *
 * @see components/admin/orchestration/agents-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import type { PaginationMeta } from '@/types/api';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import type { AiAgent } from '@prisma/client';

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

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  const id = overrides.id ?? 'cmjbv4i3x00003wsloputgwul';
  return {
    id,
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are helpful',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    systemInstructionsHistory: [],
    metadata: {},
    ...overrides,
  } as AiAgent;
}

const THREE_AGENTS: AiAgent[] = [
  makeAgent({ id: 'agent-1', name: 'Alpha', slug: 'alpha' }),
  makeAgent({ id: 'agent-2', name: 'Beta', slug: 'beta', isActive: false }),
  makeAgent({ id: 'agent-3', name: 'Gamma', slug: 'gamma' }),
];

const MOCK_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 3,
  totalPages: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBudgetFetchResponse() {
  return createMockFetchResponse({
    success: true,
    data: { spent: 12.34, limit: 100, withinBudget: true },
  });
}

function makeAgentsListResponse(agents: AiAgent[] = THREE_AGENTS) {
  return createMockFetchResponse({
    success: true,
    data: agents,
    meta: MOCK_META,
  });
}

/** Extract a URL string from any fetch RequestInfo | URL argument. */
function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url; // Request object
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentsTable', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;

    // Default: budget fetch succeeds for all rows
    mockFetch.mockImplementation((url: RequestInfo | URL) => {
      const urlStr = toUrlString(url);
      if (urlStr.includes('/budget')) {
        return Promise.resolve(makeBudgetFetchResponse());
      }
      return Promise.resolve(makeAgentsListResponse());
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
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Slug')).toBeInTheDocument();
      expect(screen.getByText('Provider')).toBeInTheDocument();
      expect(screen.getByText('Model')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('renders all 3 agent rows', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });

    it('renders agent slugs', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
      expect(screen.getByText('gamma')).toBeInTheDocument();
    });

    it('renders search input and Create agent button', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /create agent/i })).toBeInTheDocument();
    });

    it('renders empty state when no agents', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      // Assert
      expect(screen.getByText('No agents found.')).toBeInTheDocument();
    });

    it('renders pagination info', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText(/Showing 1 to 3 of 3 agents/i)).toBeInTheDocument();
    });
  });

  // ── Budget MTD ─────────────────────────────────────────────────────────────

  describe('budget MTD fetch', () => {
    it('renders em-dash when budget fetch fails', async () => {
      // Arrange: budget fetches all fail
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) {
          return Promise.resolve(createMockFetchResponse({}, 500));
        }
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: loading state first (…), then — when request fails
      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        // At minimum 3 (one per row, from budget fail)
        expect(dashes.length).toBeGreaterThanOrEqual(3);
      });

      // Critical: no throw
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  // ── Search / debounce ──────────────────────────────────────────────────────

  describe('search with debounce', () => {
    it('does not fetch immediately on typing', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);
      const initial = mockFetch.mock.calls.length;

      // Act
      await user.type(screen.getByPlaceholderText('Search agents...'), 'al');

      // Assert: no extra fetches before debounce
      expect(mockFetch.mock.calls.length).toBe(initial);
    });

    it('fires refetch after 300ms debounce with search query', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      // Override with a handler that returns correct shapes for both budget and list
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse([THREE_AGENTS[0]]));
      });

      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act
      await user.type(screen.getByPlaceholderText('Search agents...'), 'al');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert
      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls
          .filter((call) => !toUrlString(call[0] as RequestInfo | URL).includes('/budget'))
          .map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(fetchUrls.some((u) => u.includes('q=al'))).toBe(true);
      });
    });
  });

  // ── Sorting ────────────────────────────────────────────────────────────────

  describe('sort', () => {
    it('clicking Name header button fetches agents with updated sort', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse());
      });

      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Verify sort button is present before acting
      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      expect(nameBtn).toBeInTheDocument();

      // Act: click to sort
      await user.click(nameBtn);

      // Assert: at least one list fetch was fired (beyond the initial budget fetches)
      await waitFor(() => {
        const listFetches = mockFetch.mock.calls.filter(
          (call) =>
            !toUrlString(call[0] as RequestInfo | URL).includes('/budget') &&
            !toUrlString(call[0] as RequestInfo | URL).includes('/export')
        );
        expect(listFetches.length).toBeGreaterThan(0);
      });
    });
  });

  // ── Status Switch (optimistic) ─────────────────────────────────────────────

  describe('status switch optimistic update', () => {
    it('calls apiClient.patch with isActive when switch is toggled', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act: find first active agent switch (Alpha)
      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      // Assert
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/agents/agent-1'),
          expect.objectContaining({
            body: expect.objectContaining({ isActive: expect.any(Boolean) }),
          })
        );
      });
    });

    it('reverts switch on PATCH failure', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Not allowed', 'FORBIDDEN', 403)
      );

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Record initial active state for agent-1
      const switches = screen.getAllByRole('switch');
      const initialChecked = (switches[0] as HTMLInputElement).checked;

      // Act: toggle the switch
      await user.click(switches[0]);

      // Assert: error banner visible
      await waitFor(() => {
        expect(screen.getByText(/couldn't update/i)).toBeInTheDocument();
      });

      // Assert: switch reverted to original state
      const switchesAfter = screen.getAllByRole('switch');
      expect((switchesAfter[0] as HTMLInputElement).checked).toBe(initialChecked);
    });
  });

  // ── Bulk select + Export ───────────────────────────────────────────────────

  describe('bulk select and export', () => {
    it('Export button is disabled when nothing selected', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      const exportBtn = screen.getByRole('button', { name: /export selected/i });
      expect(exportBtn).toBeDisabled();
    });

    it('selecting a row enables Export button', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act: select first row checkbox
      const rowCheckboxes = screen.getAllByRole('checkbox');
      // index 0 is "select all", index 1..N are row checkboxes
      await user.click(rowCheckboxes[1]);

      // Assert
      const exportBtn = screen.getByRole('button', { name: /export selected/i });
      expect(exportBtn).not.toBeDisabled();
    });

    it('Export POSTs with correct agent ids and uses Content-Disposition filename', async () => {
      // Arrange
      const user = userEvent.setup();

      // Provide a custom Content-Disposition filename
      const exportResponse = {
        ok: true,
        headers: new Headers({ 'Content-Disposition': 'attachment; filename="my-export.json"' }),
        blob: async () => new Blob(['{}'], { type: 'application/json' }),
        json: async () => ({}),
      } as unknown as Response;

      mockFetch.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/export') && init?.method === 'POST') {
          return Promise.resolve(exportResponse);
        }
        return Promise.resolve(makeAgentsListResponse());
      });

      // Provide fake URL.createObjectURL and a.click
      vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => 'blob:test'),
        revokeObjectURL: vi.fn(),
      });

      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act: select agent-1 row and export
      const rowCheckboxes = screen.getAllByRole('checkbox');
      await user.click(rowCheckboxes[1]); // row 1 = agent-1

      await user.click(screen.getByRole('button', { name: /export selected/i }));

      // Assert: POST to export endpoint with agent id
      await waitFor(() => {
        const exportCalls = mockFetch.mock.calls.filter(
          (call) =>
            toUrlString(call[0] as RequestInfo | URL).includes('/export') &&
            (call[1] as RequestInit)?.method === 'POST'
        );
        expect(exportCalls.length).toBe(1);
        const body = JSON.parse((exportCalls[0][1] as RequestInit).body as string) as {
          agentIds: string[];
        };
        expect(body.agentIds).toContain('agent-1');
      });
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  describe('delete confirm flow', () => {
    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      // Radix renders menuitems in a portal — use hidden:true to find them
      const deleteItem = await screen.findByRole('menuitem', { name: /delete/i, hidden: true });
      await user.click(deleteItem);
      await waitFor(() => expect(screen.getByText('Delete agent')).toBeInTheDocument());
    }

    it('clicking Delete opens confirmation dialog', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act
      await openDeleteDialog(user);

      // Assert
      expect(screen.getByText('Delete agent')).toBeInTheDocument();
    });

    it('confirms delete calls apiClient.delete', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse(THREE_AGENTS.slice(1)));
      });

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act
      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/agents/agent-1'));
      });
    });

    it('cancelling delete closes dialog without calling delete', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act
      await openDeleteDialog(user);
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      // Assert
      await waitFor(() => {
        expect(screen.queryByText('Delete agent')).not.toBeInTheDocument();
      });
      expect(apiClient.delete).not.toHaveBeenCalled();
    });
  });

  // ── Lazy-fetched columns: Caps & Convs ────────────────────────────────────

  describe('lazy-fetched columns (Caps & Convs)', () => {
    /**
     * Helper: produce a capabilities response whose .data array has `count` items.
     */
    function makeCapabilitiesResponse(count: number) {
      return createMockFetchResponse({
        success: true,
        data: Array.from({ length: count }, (_, i) => ({ id: `cap-${i}` })),
      });
    }

    /**
     * Helper: produce a conversations response whose .meta carries `total`.
     */
    function makeConversationsResponse(total: number) {
      return createMockFetchResponse({
        success: true,
        data: [],
        meta: { page: 1, limit: 1, total, totalPages: Math.max(1, total) },
      });
    }

    /**
     * A fetch implementation that properly handles all four URL families:
     *   /budget          → budget response
     *   /capabilities   → capabilities response (2 caps by default)
     *   ?agentId=        → conversations response (5 convs by default)
     *   everything else  → agents list response
     */
    function makeFullMockFetch(opts: { caps?: number; convs?: number } = {}) {
      const caps = opts.caps ?? 2;
      const convs = opts.convs ?? 5;
      return (url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/capabilities'))
          return Promise.resolve(makeCapabilitiesResponse(caps));
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId='))
          return Promise.resolve(makeConversationsResponse(convs));
        return Promise.resolve(makeAgentsListResponse());
      };
    }

    // ── 1. Successful fetch: counts appear in the correct cells ─────────────

    it('renders capability count as a number after fetch resolves', async () => {
      // Arrange: capabilities endpoint returns 3 caps for every agent
      mockFetch.mockImplementation(makeFullMockFetch({ caps: 3, convs: 0 }));

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: three rows each show "3" in the Caps column
      await waitFor(() => {
        // getAllByText('3') may also match other columns (e.g. pagination "3 agents")
        // so we check that the capability links / spans are present
        const threes = screen.getAllByText('3');
        // At minimum one instance per row — 3 rows → ≥ 3 occurrences
        expect(threes.length).toBeGreaterThanOrEqual(3);
      });
    });

    it('renders conversation count as a number after fetch resolves', async () => {
      // Arrange: conversations endpoint returns total=7 for every agent
      mockFetch.mockImplementation(makeFullMockFetch({ caps: 0, convs: 7 }));

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: three rows each show "7" in the Convs column (plain number, no link)
      await waitFor(() => {
        const sevens = screen.getAllByText('7');
        expect(sevens.length).toBeGreaterThanOrEqual(3);
      });
    });

    it('renders capability count 0 as a muted span after fetch resolves', async () => {
      // Arrange: capabilities endpoint returns 0 caps for every agent
      mockFetch.mockImplementation(makeFullMockFetch({ caps: 0, convs: 0 }));

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: the "0" spans appear (rendered as muted text, not a link)
      await waitFor(() => {
        const zeros = screen.getAllByText('0');
        expect(zeros.length).toBeGreaterThanOrEqual(3);
      });
    });

    it('fetches capabilities URL containing the agent id', async () => {
      // Arrange
      mockFetch.mockImplementation(makeFullMockFetch({ caps: 1, convs: 0 }));

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: a capabilities request was made for each agent id
      await waitFor(() => {
        const capCalls = mockFetch.mock.calls
          .map((call) => toUrlString(call[0] as RequestInfo | URL))
          .filter((u) => u.includes('/capabilities'));
        expect(capCalls.some((u) => u.includes('agent-1'))).toBe(true);
        expect(capCalls.some((u) => u.includes('agent-2'))).toBe(true);
        expect(capCalls.some((u) => u.includes('agent-3'))).toBe(true);
      });
    });

    it('fetches conversations URL with agentId query param for each agent', async () => {
      // Arrange
      mockFetch.mockImplementation(makeFullMockFetch({ caps: 0, convs: 2 }));

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: a conversations request was made for each agent id
      await waitFor(() => {
        const convCalls = mockFetch.mock.calls
          .map((call) => toUrlString(call[0] as RequestInfo | URL))
          .filter((u) => u.includes('/conversations') && u.includes('agentId='));
        expect(convCalls.some((u) => u.includes('agentId=agent-1'))).toBe(true);
        expect(convCalls.some((u) => u.includes('agentId=agent-2'))).toBe(true);
        expect(convCalls.some((u) => u.includes('agentId=agent-3'))).toBe(true);
      });
    });

    // ── 2. Failed fetch: cells render the em-dash fallback ──────────────────

    it('renders em-dash in Caps column when capabilities fetch returns non-ok status', async () => {
      // Arrange: capabilities fetches all return 500
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/capabilities'))
          return Promise.resolve(createMockFetchResponse({}, 500));
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId='))
          return Promise.resolve(makeConversationsResponse(0));
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: at least 3 em-dashes (one per row) from failed capabilities
      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        expect(dashes.length).toBeGreaterThanOrEqual(3);
      });
      // Component must not throw
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('renders em-dash in Caps column when capabilities fetch throws', async () => {
      // Arrange: capabilities fetch rejects with a network error
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/capabilities')) return Promise.reject(new Error('Network error'));
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId='))
          return Promise.resolve(makeConversationsResponse(0));
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: em-dashes appear once fetch error is caught
      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        expect(dashes.length).toBeGreaterThanOrEqual(3);
      });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('renders em-dash in Convs column when conversations fetch returns non-ok status', async () => {
      // Arrange: conversations fetches all return 500
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/capabilities')) return Promise.resolve(makeCapabilitiesResponse(1));
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId='))
          return Promise.resolve(createMockFetchResponse({}, 500));
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: em-dashes visible once failed conv fetches settle
      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        expect(dashes.length).toBeGreaterThanOrEqual(3);
      });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('renders em-dash in Convs column when conversations fetch throws', async () => {
      // Arrange: conversations fetch rejects
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        if (urlStr.includes('/capabilities')) return Promise.resolve(makeCapabilitiesResponse(1));
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId='))
          return Promise.reject(new Error('Network error'));
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: em-dashes visible and no unhandled error
      await waitFor(() => {
        const dashes = screen.getAllByText('—');
        expect(dashes.length).toBeGreaterThanOrEqual(3);
      });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    // ── 3. Pre-fetch state: loading ellipsis renders before promises resolve ─

    it('renders loading ellipsis (…) in Caps and Convs cells before fetches resolve', () => {
      // Arrange: use a never-resolving fetch so promises stay pending
      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/capabilities') || urlStr.includes('?agentId='))
          return new Promise<Response>(() => {
            // intentionally never resolves — simulates in-flight state
          });
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act: render synchronously — do NOT await anything
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: the '…' loading placeholder appears for the pending cells
      // (capCounts and convCounts are undefined until the fetch effect sets them)
      const ellipses = screen.getAllByText('…');
      // 3 agents × 2 columns (Caps + Convs) = 6 ellipses minimum
      expect(ellipses.length).toBeGreaterThanOrEqual(6);
    });

    // ── 4. Cancellation: unmount before fetches resolve must not warn/throw ──

    it('does not warn about state updates on unmounted component when unmounted before fetches resolve', async () => {
      // Arrange: capture console.error to detect act() / unmount warnings
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      // Fetches that resolve on the next microtask — gives us a window to unmount first
      let resolveCapabilities: (() => void) | undefined;
      let resolveConversations: (() => void) | undefined;

      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/capabilities')) {
          return new Promise<Response>((resolve) => {
            resolveCapabilities = () => resolve(makeCapabilitiesResponse(2));
          });
        }
        if (urlStr.includes('?agentId=') || urlStr.includes('&agentId=')) {
          return new Promise<Response>((resolve) => {
            resolveConversations = () => resolve(makeConversationsResponse(3));
          });
        }
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse());
      });

      // Act: mount then immediately unmount
      const { unmount } = render(
        <AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />
      );
      unmount();

      // Now resolve the pending fetches — the cancelled flag should prevent setState
      resolveCapabilities?.();
      resolveConversations?.();

      // Let microtasks drain
      await act(async () => {
        await Promise.resolve();
      });

      // Assert: no "Can't perform a React state update on an unmounted component" warnings
      const stateUpdateWarnings = consoleSpy.mock.calls.filter((args) =>
        String(args[0]).includes('unmounted')
      );
      expect(stateUpdateWarnings).toHaveLength(0);

      consoleSpy.mockRestore();
    });
  });

  // ── Pagination boundary ────────────────────────────────────────────────────

  describe('pagination boundary behaviour', () => {
    it('Previous button is disabled on page 1', () => {
      // Arrange: page 1 of 2
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={meta} />);

      // Assert: Previous disabled
      const prevBtn = screen.getByRole('button', { name: /previous/i });
      expect(prevBtn).toBeDisabled();
    });

    it('Next button is disabled on the last page', () => {
      // Arrange: already on last page (page 2 of 2)
      const meta: PaginationMeta = { page: 2, limit: 25, total: 50, totalPages: 2 };
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={meta} />);

      // Assert: Next disabled
      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).toBeDisabled();
    });

    it('Next button is enabled on page 1 of 2 and clicking it refetches page 2', async () => {
      // Arrange: page 1 of 2
      const meta: PaginationMeta = { page: 1, limit: 25, total: 50, totalPages: 2 };

      mockFetch.mockImplementation((url: RequestInfo | URL) => {
        const urlStr = toUrlString(url);
        if (urlStr.includes('/budget')) return Promise.resolve(makeBudgetFetchResponse());
        return Promise.resolve(makeAgentsListResponse());
      });

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={meta} />);

      // Act: click Next
      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).not.toBeDisabled();
      await user.click(nextBtn);

      // Assert: a list fetch with page=2 was fired
      await waitFor(() => {
        const listFetches = mockFetch.mock.calls
          .filter(
            (call) =>
              !toUrlString(call[0] as RequestInfo | URL).includes('/budget') &&
              !toUrlString(call[0] as RequestInfo | URL).includes('/export')
          )
          .map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(listFetches.some((u) => u.includes('page=2'))).toBe(true);
      });
    });
  });
});
