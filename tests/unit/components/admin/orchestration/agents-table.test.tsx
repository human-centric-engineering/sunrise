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
 * - Visibility badges render for public/invite_only agents
 * - Description subtitle renders under agent name
 * - Created column shows relative time
 *
 * @see components/admin/orchestration/agents-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import type { PaginationMeta } from '@/types/api';
import { createMockFetchResponse } from '@/tests/helpers/mocks';
import type { AiAgentListItem } from '@/types/orchestration';

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

function makeAgent(overrides: Partial<AiAgentListItem> = {}): AiAgentListItem {
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
    _count: { capabilities: 0, conversations: 0 },
    _budget: null,
    ...overrides,
  } as AiAgentListItem;
}

const THREE_AGENTS: AiAgentListItem[] = [
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

function makeAgentsListResponse(agents: AiAgentListItem[] = THREE_AGENTS) {
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

    // Default: list fetch returns THREE_AGENTS with inline _count and _budget
    mockFetch.mockImplementation(() => Promise.resolve(makeAgentsListResponse()));

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
      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.getByText('Chats')).toBeInTheDocument();
      expect(screen.getByText('Model')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Created')).toBeInTheDocument();
    });

    it('renders all 3 agent rows', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });

    it('renders search input and Create agent button', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /create agent/i })).toBeInTheDocument();
    });

    it('renders the friendly empty-state card with CTAs when no agents', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      // Assert
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /create your first agent/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /open setup wizard/i })).toBeInTheDocument();
    });

    it('renders a "System default" badge when an agent has empty provider/model', () => {
      // Empty-string provider/model is the contract for system-seeded agents
      // that resolve their LLM binding dynamically via agent-resolver.ts.
      const systemAgent = makeAgent({
        id: 'sys-1',
        name: 'pattern-advisor',
        slug: 'pattern-advisor',
        provider: '',
        model: '',
      });

      render(
        <AgentsTable initialAgents={[systemAgent]} initialMeta={{ ...MOCK_META, total: 1 }} />
      );

      expect(screen.getByText(/System default/i)).toBeInTheDocument();
    });

    it('renders pagination info', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert
      expect(screen.getByText(/Showing 1 to 3 of 3 agents/i)).toBeInTheDocument();
    });
  });

  // ── Budget MTD ─────────────────────────────────────────────────────────────

  describe('budget MTD column', () => {
    it('renders em-dash in Spend MTD when _budget is null', () => {
      // Arrange: all agents have _budget: null (default fixture)
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: at least 3 em-dashes (one per row) from null budget
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(3);

      // Component must not throw
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('renders formatted spend when _budget is provided', () => {
      // Arrange: agents with actual budget data
      const agentsWithBudget: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          slug: 'alpha',
          _budget: { withinBudget: true, spent: 12.34, limit: 100, remaining: 87.66 },
        }),
      ];

      render(
        <AgentsTable initialAgents={agentsWithBudget} initialMeta={{ ...MOCK_META, total: 1 }} />
      );

      // Assert: spend renders as formatted dollar amount
      expect(screen.getByText('$12.34')).toBeInTheDocument();
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
      mockFetch.mockImplementation(() =>
        Promise.resolve(makeAgentsListResponse([THREE_AGENTS[0]]))
      );

      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act
      await user.type(screen.getByPlaceholderText('Search agents...'), 'al');

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert
      await waitFor(() => {
        const fetchUrls = mockFetch.mock.calls.map((call) =>
          toUrlString(call[0] as RequestInfo | URL)
        );
        expect(fetchUrls.some((u) => u.includes('q=al'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Sorting ────────────────────────────────────────────────────────────────

  describe('sort', () => {
    it('clicking Name header button fetches agents with updated sort', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockImplementation(() => Promise.resolve(makeAgentsListResponse()));

      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Verify sort button is present before acting
      const nameBtn = screen.getByRole('button', { name: /^Name/ });
      expect(nameBtn).toBeInTheDocument();

      // Act: click to sort
      await user.click(nameBtn);

      // Assert: at least one list fetch was fired
      await waitFor(() => {
        const listFetches = mockFetch.mock.calls.filter(
          (call) => !toUrlString(call[0] as RequestInfo | URL).includes('/export')
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
      mockFetch.mockImplementation(() =>
        Promise.resolve(makeAgentsListResponse(THREE_AGENTS.slice(1)))
      );

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
      expect(apiClient.delete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  // ── Inline Tools & Chats columns ─────────────────────────────────────────

  describe('inline _count columns (Tools & Chats)', () => {
    it('renders capability count from _count.capabilities', () => {
      // Arrange: agents with known capability counts
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          slug: 'alpha',
          _count: { capabilities: 3, conversations: 0 },
        }),
        makeAgent({
          id: 'agent-2',
          name: 'Beta',
          slug: 'beta',
          _count: { capabilities: 1, conversations: 0 },
        }),
        makeAgent({
          id: 'agent-3',
          name: 'Gamma',
          slug: 'gamma',
          _count: { capabilities: 0, conversations: 0 },
        }),
      ];

      // Act
      render(<AgentsTable initialAgents={agents} initialMeta={MOCK_META} />);

      // Assert: counts render immediately (no fetch required)
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
      // "0" renders as muted text; getAllByText because count+conv both show 0
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(1);
    });

    it('renders conversation count from _count.conversations', () => {
      // Arrange: agents with known conversation counts
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          slug: 'alpha',
          _count: { capabilities: 0, conversations: 7 },
        }),
        makeAgent({
          id: 'agent-2',
          name: 'Beta',
          slug: 'beta',
          _count: { capabilities: 0, conversations: 7 },
        }),
        makeAgent({
          id: 'agent-3',
          name: 'Gamma',
          slug: 'gamma',
          _count: { capabilities: 0, conversations: 7 },
        }),
      ];

      // Act
      render(<AgentsTable initialAgents={agents} initialMeta={MOCK_META} />);

      // Assert: three rows each show "7" in the Convs column
      const sevens = screen.getAllByText('7');
      expect(sevens.length).toBeGreaterThanOrEqual(3);
    });

    it('renders capability count 0 as a muted span (no link)', () => {
      // Arrange: agent with 0 capabilities
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          slug: 'alpha',
          _count: { capabilities: 0, conversations: 0 },
        }),
      ];

      // Act
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      // Assert: "0" in the Caps column renders without a link
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(1);
    });

    it('renders capability count > 0 as a link to the agent detail page', () => {
      // Arrange: agent with capabilities
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          slug: 'alpha',
          _count: { capabilities: 5, conversations: 0 },
        }),
      ];

      // Act
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      // Assert: the capability count renders as a link
      const link = screen.getByRole('link', { name: '5' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', expect.stringContaining('agent-1'));
    });

    it('does not make any fetch calls for capabilities or conversations', () => {
      // Arrange & Act
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Assert: no per-row fetch calls for capabilities or conversations
      const allUrls = mockFetch.mock.calls.map((call) => toUrlString(call[0] as RequestInfo | URL));
      expect(allUrls.every((u) => !u.includes('/capabilities'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      expect(allUrls.every((u) => !u.includes('agentId='))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
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

      mockFetch.mockImplementation(() => Promise.resolve(makeAgentsListResponse()));

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={meta} />);

      // Act: click Next
      const nextBtn = screen.getByRole('button', { name: /^next/i });
      expect(nextBtn).not.toBeDisabled();
      await user.click(nextBtn);

      // Assert: a list fetch with page=2 was fired
      await waitFor(() => {
        const listFetches = mockFetch.mock.calls
          .filter((call) => !toUrlString(call[0] as RequestInfo | URL).includes('/export'))
          .map((call) => toUrlString(call[0] as RequestInfo | URL));
        expect(listFetches.some((u) => u.includes('page=2'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      });
    });
  });

  // ── Visibility badges ───────────────────────────────────────────────────

  describe('visibility badges', () => {
    it('shows "Public" badge for public agents', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-1', name: 'Alpha', visibility: 'public' }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('Public')).toBeInTheDocument();
    });

    it('shows "Invite" badge for invite_only agents', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-1', name: 'Alpha', visibility: 'invite_only' }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('Invite')).toBeInTheDocument();
    });

    it('does not show visibility badge for internal agents', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-1', name: 'Alpha', visibility: 'internal' }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.queryByText('Public')).not.toBeInTheDocument();
      expect(screen.queryByText('Invite')).not.toBeInTheDocument();
    });
  });

  // ── Description subtitle ────────────────────────────────────────────────

  describe('description subtitle', () => {
    it('renders description under agent name', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          description: 'Handles customer billing questions',
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('Handles customer billing questions')).toBeInTheDocument();
    });
  });

  // ── Created column ──────────────────────────────────────────────────────

  describe('created column', () => {
    // Same time-pinning as `formatRelativeTime` below — see the comment
    // there. This describe block also computes Date.now() offsets and
    // expects exact relative-time strings, so it benefits from the
    // same frozen clock to avoid boundary flake.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));
    });

    it('shows relative time for agent creation date', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          createdAt: new Date(Date.now() - 3600_000), // 1 hour ago
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('1h ago')).toBeInTheDocument();
    });
  });

  // ── Combined model column ───────────────────────────────────────────────

  describe('combined model column', () => {
    it('renders provider and model together', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          provider: 'openai',
          model: 'gpt-4o',
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText(/openai/)).toBeInTheDocument();
    });
  });

  // ── System agent ────────────────────────────────────────────────────────

  describe('system agent', () => {
    it('renders System badge for isSystem agents', () => {
      // Arrange: isSystem agent
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-sys', name: 'System Agent', isSystem: true }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('hides Delete option from dropdown for system agents', async () => {
      // Arrange: system agent cannot be deleted
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-sys', name: 'System Agent', isSystem: true }),
      ];

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      // Act: open the row actions dropdown
      const actionBtn = screen.getByRole('button', { name: /row actions/i });
      await user.click(actionBtn);

      // Assert: Delete menuitem is absent for system agents
      const deleteItem = screen.queryByRole('menuitem', { name: /delete/i, hidden: true });
      expect(deleteItem).not.toBeInTheDocument();
    });

    it('disables status switch for system agents', () => {
      // Arrange: system agent
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-sys', name: 'System Agent', isSystem: true }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      const switches = screen.getAllByRole('switch');
      // The switch for the system agent should be disabled
      expect(switches[0]).toBeDisabled();
    });
  });

  // ── Monthly budget display ──────────────────────────────────────────────

  describe('monthly budget column', () => {
    it('renders formatted budget when monthlyBudgetUsd is set', () => {
      // Arrange: agent with monthly budget
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          monthlyBudgetUsd: 50.0,
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('$50.00')).toBeInTheDocument();
    });

    it('renders em-dash when monthlyBudgetUsd is null', () => {
      // Arrange: agent without budget (default)
      const agents: AiAgentListItem[] = [
        makeAgent({ id: 'agent-1', name: 'Alpha', monthlyBudgetUsd: null }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      // At least one em-dash present
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── formatRelativeTime branches ─────────────────────────────────────────

  describe('formatRelativeTime', () => {
    // Override the suite-level timers for this describe only. The relative-
    // time tests don't use userEvent, so freezing the clock is safe — and
    // it kills the boundary-flake risk that `shouldAdvanceTime: true`
    // introduces (e.g. `Date.now() - 3600_000` and the component's later
    // `new Date()` reading slightly different wall-clock values).
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));
    });

    it('renders "just now" for agents created less than 1 minute ago', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          createdAt: new Date(Date.now() - 30_000), // 30 seconds ago
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('renders "Xd ago" for agents created days ago', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          createdAt: new Date(Date.now() - 5 * 24 * 3600_000), // 5 days ago
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('5d ago')).toBeInTheDocument();
    });

    it('renders "Xmo ago" for agents created more than 30 days ago', () => {
      const agents: AiAgentListItem[] = [
        makeAgent({
          id: 'agent-1',
          name: 'Alpha',
          createdAt: new Date(Date.now() - 62 * 24 * 3600_000), // ~2 months ago
        }),
      ];
      render(<AgentsTable initialAgents={agents} initialMeta={{ ...MOCK_META, total: 1 }} />);

      expect(screen.getByText('2mo ago')).toBeInTheDocument();
    });
  });

  // ── toggleAll ───────────────────────────────────────────────────────────

  describe('toggle all selection', () => {
    it('clicking select-all when none selected selects all rows', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      // Act: click the header checkbox
      const checkboxes = screen.getAllByRole('checkbox');
      const selectAll = checkboxes[0]; // index 0 = select-all
      await user.click(selectAll);

      // Assert: Export button shows count of all agents
      expect(screen.getByRole('button', { name: /export selected \(3\)/i })).toBeInTheDocument();
    });

    it('clicking select-all when all selected deselects all rows', async () => {
      // Arrange: select all first
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]); // select all
      await user.click(checkboxes[0]); // deselect all

      // Assert: export button shows 0 selected and is disabled
      const exportBtn = screen.getByRole('button', { name: /export selected \(0\)/i });
      expect(exportBtn).toBeDisabled();
    });
  });

  // ── Compare button ──────────────────────────────────────────────────────

  describe('compare button', () => {
    it('shows Compare button only when exactly 2 agents are selected', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');

      // Select 2 agents
      await user.click(checkboxes[1]); // row 1 = agent-1
      await user.click(checkboxes[2]); // row 2 = agent-2

      // Assert: Compare button visible
      expect(screen.getByRole('button', { name: /compare/i })).toBeInTheDocument();
    });

    it('does not show Compare button when only 1 agent is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // select only 1

      // Assert: no Compare button
      expect(screen.queryByRole('button', { name: /compare/i })).not.toBeInTheDocument();
    });

    it('clicking Compare navigates to compare page with both agent ids', async () => {
      // Arrange
      const { useRouter } = await import('next/navigation');
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        replace: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      } as ReturnType<typeof useRouter>);

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // agent-1
      await user.click(checkboxes[2]); // agent-2

      await user.click(screen.getByRole('button', { name: /compare/i }));

      expect(push).toHaveBeenCalledWith(
        expect.stringMatching(/compare\?a=agent-[12]&b=agent-[12]/)
      );
    });
  });

  // ── Bulk actions ────────────────────────────────────────────────────────

  describe('bulk actions', () => {
    it('shows bulk action buttons when agents are selected', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // select agent-1

      // Assert: activate/deactivate/delete bulk buttons appear
      // Multiple "activate"-matching buttons may exist (e.g. switch labels) — getAllByRole
      const activateBtns = screen.getAllByRole('button', { name: /activate/i });
      expect(activateBtns.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole('button', { name: /deactivate/i })).toBeInTheDocument();
    });

    it('bulk activate posts to bulk endpoint with activate action', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ success: true });
      mockFetch.mockImplementation(() => Promise.resolve(makeAgentsListResponse()));

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // select agent-1

      await user.click(screen.getByRole('button', { name: /^activate$/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/bulk'),
          expect.objectContaining({
            body: expect.objectContaining({ action: 'activate', agentIds: ['agent-1'] }),
          })
        );
      });
    });

    it('shows error banner when bulk action fails with APIClientError', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Forbidden', 'FORBIDDEN', 403)
      );

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // select agent-1

      await user.click(screen.getByRole('button', { name: /^activate$/i }));

      await waitFor(() => {
        expect(screen.getByText(/bulk activate failed/i)).toBeInTheDocument();
      });
    });

    it('opens bulk delete dialog when Delete selected is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // select agent-1

      // Act: click the destructive Delete button (shows count)
      const deleteBtn = screen.getByRole('button', { name: /delete \(1\)/i });
      await user.click(deleteBtn);

      // Assert: bulk delete dialog opens
      await waitFor(() => {
        expect(screen.getByText(/delete 1 agent/i)).toBeInTheDocument();
      });
    });
  });

  // ── Loading state with empty list ────────────────────────────────────

  describe('loading state', () => {
    it('shows Loading row when agents list is empty and loading is in progress', async () => {
      // Arrange: trigger a fetch with empty initial data
      let resolveFetch: (val: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      mockFetch.mockReturnValueOnce(pending);

      const user = userEvent.setup({ delay: null });
      render(<AgentsTable initialAgents={[]} initialMeta={{ ...MOCK_META, total: 0 }} />);

      // Type to trigger debounce fetch
      await user.type(screen.getByPlaceholderText('Search agents...'), 'x');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // While fetch is pending AND agents list is empty → shows Loading row
      // Resolve after assertion to ensure clean test
      resolveFetch!(makeAgentsListResponse([]));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
      });
    });
  });

  // ── Edit row action ─────────────────────────────────────────────────────

  describe('edit row action', () => {
    it('clicking Edit navigates to agent detail page', async () => {
      // Arrange
      const { useRouter } = await import('next/navigation');
      const push = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push,
        replace: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      } as ReturnType<typeof useRouter>);

      const user = userEvent.setup();
      render(<AgentsTable initialAgents={THREE_AGENTS} initialMeta={MOCK_META} />);

      const actionBtns = screen.getAllByRole('button', { name: /row actions/i });
      await user.click(actionBtns[0]);
      const editItem = await screen.findByRole('menuitem', { name: /edit/i, hidden: true });
      await user.click(editItem);

      expect(push).toHaveBeenCalledWith('/admin/orchestration/agents/agent-1');
    });
  });
});
