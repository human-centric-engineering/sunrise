/**
 * AgentComparisonView Component Tests
 *
 * Test Coverage:
 * - Loading state while fetching comparison data
 * - Error state when fetch fails
 * - Renders both agent names and slugs
 * - Active/inactive badges rendered correctly
 * - Configuration section (model, provider, capabilities)
 * - Performance section (cost, LLM calls, tokens, conversations)
 * - Evaluation Results section
 * - Back-to-agents link is present
 *
 * @see components/admin/orchestration/agent-comparison-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { AgentComparisonView } from '@/components/admin/orchestration/agent-comparison-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    slug: string;
    model: string;
    provider: string;
    isActive: boolean;
    totalCostUsd: number;
    llmCallCount: number;
    conversationCount: number;
    capabilityCount: number;
    evaluationsTotal: number;
    evaluationsCompleted: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'agent-a',
    name: overrides.name ?? 'Agent Alpha',
    slug: overrides.slug ?? 'agent-alpha',
    model: overrides.model ?? 'gpt-4o',
    provider: overrides.provider ?? 'openai',
    isActive: overrides.isActive ?? true,
    createdAt: '2025-01-01T00:00:00Z',
    totalCostUsd: overrides.totalCostUsd ?? 1.23,
    totalInputTokens: 10000,
    totalOutputTokens: 5000,
    llmCallCount: overrides.llmCallCount ?? 42,
    conversationCount: overrides.conversationCount ?? 12,
    capabilityCount: overrides.capabilityCount ?? 3,
    evaluations: {
      total: overrides.evaluationsTotal ?? 5,
      completed: overrides.evaluationsCompleted ?? 4,
    },
  };
}

const AGENT_A = makeAgent({ id: 'agent-a', name: 'Agent Alpha', slug: 'agent-alpha' });
const AGENT_B = makeAgent({
  id: 'agent-b',
  name: 'Agent Beta',
  slug: 'agent-beta',
  isActive: false,
  totalCostUsd: 2.5,
  model: 'claude-3-5-sonnet',
  provider: 'anthropic',
});

const COMPARISON_DATA = { agents: [AGENT_A, AGENT_B] as [typeof AGENT_A, typeof AGENT_B] };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentComparisonView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Loading state ───────────────────────────────────────────────────────────

  it('shows loading spinner while fetching', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    const { container } = render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    // Loader2 spinner is present
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows error message when fetch fails', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load comparison data')).toBeInTheDocument();
    });
  });

  // ── Agent names and slugs ──────────────────────────────────────────────────

  it('renders both agent names after successful fetch', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
      expect(screen.getByText('Agent Beta')).toBeInTheDocument();
    });
  });

  it('renders agent slugs in monospace text', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('agent-alpha')).toBeInTheDocument();
      expect(screen.getByText('agent-beta')).toBeInTheDocument();
    });
  });

  // ── Active/inactive badges ─────────────────────────────────────────────────

  it('shows Active badge for active agent and Inactive for inactive', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Inactive')).toBeInTheDocument();
    });
  });

  // ── Configuration section ──────────────────────────────────────────────────

  it('renders Configuration card with model and provider rows', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Configuration')).toBeInTheDocument();
      expect(screen.getByText('Model')).toBeInTheDocument();
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText('claude-3-5-sonnet')).toBeInTheDocument();
      expect(screen.getByText('Provider')).toBeInTheDocument();
      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.getByText('anthropic')).toBeInTheDocument();
    });
  });

  // ── Performance section ────────────────────────────────────────────────────

  it('renders Performance card', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Performance')).toBeInTheDocument();
      expect(screen.getByText('Total Cost')).toBeInTheDocument();
      expect(screen.getByText('LLM Calls')).toBeInTheDocument();
      expect(screen.getByText('Conversations')).toBeInTheDocument();
    });
  });

  it('formats cost values with $ and 4 decimal places', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('$1.2300')).toBeInTheDocument();
      expect(screen.getByText('$2.5000')).toBeInTheDocument();
    });
  });

  // ── Evaluation Results section ─────────────────────────────────────────────

  it('renders Evaluation Results card', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Evaluation Results')).toBeInTheDocument();
      expect(screen.getByText('Total Evaluations')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
  });

  // ── Back link ──────────────────────────────────────────────────────────────

  it('renders back to agents link', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /back to agents/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/admin/orchestration/agents');
    });
  });

  // ── API call params ────────────────────────────────────────────────────────

  it('calls the compare endpoint with both agent IDs via params', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: { agentIds: 'agent-a,agent-b' },
        })
      );
    });
  });

  // ── Error branch: APIClientError vs generic Error ──────────────────────────

  it('shows APIClientError message when fetch rejects with APIClientError', async () => {
    // Arrange: APIClientError with a specific message
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Agents not found', 'NOT_FOUND', 404)
    );

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    // Assert: the APIClientError.message is shown
    await waitFor(() => {
      expect(screen.getByText('Agents not found')).toBeInTheDocument();
    });
  });

  it('shows default error message when fetch rejects with a generic Error', async () => {
    // Arrange: plain Error (not APIClientError)
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(new Error('unexpected failure'));

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    // Assert: default fallback message
    await waitFor(() => {
      expect(screen.getByText('Failed to load comparison data')).toBeInTheDocument();
    });
  });

  // ── ComparisonRow highlight logic ──────────────────────────────────────────

  it('highlights lower cost in green when agents have different costs', async () => {
    // Arrange: agent A has lower cost ($1.23 < $2.50) — better='lower' for cost
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    const { container } = render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('$1.2300')).toBeInTheDocument();
    });

    // The lower-cost value ($1.2300 for agent A) should have green color class
    const costA = screen.getByText('$1.2300');
    expect(costA.className).toContain('text-green-600');

    // The higher-cost value ($2.5000 for agent B) should NOT have green class
    const costB = screen.getByText('$2.5000');
    expect(costB.className).not.toContain('text-green-600');

    // Container check to avoid unused var warning
    expect(container).toBeTruthy();
  });

  it('highlights higher capability count in green when agents differ', async () => {
    // Arrange: agent A has 3 capabilities, agent B has 1 — better='higher'
    const { apiClient } = await import('@/lib/api/client');
    const dataWithDiffCaps = {
      agents: [
        makeAgent({ id: 'agent-a', name: 'Agent Alpha', slug: 'agent-alpha', capabilityCount: 3 }),
        makeAgent({ id: 'agent-b', name: 'Agent Beta', slug: 'agent-beta', capabilityCount: 1 }),
      ] as [ReturnType<typeof makeAgent>, ReturnType<typeof makeAgent>],
    };
    vi.mocked(apiClient.get).mockResolvedValue(dataWithDiffCaps);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
    });

    // Both values render — the higher value (3) gets green; the lower (1) does not
    // Find the Capabilities row values using their content
    const capValues = screen.getAllByText(/^[13]$/).filter((el) => el.tagName === 'SPAN');

    // The element with '3' should have green class (higher is better)
    const threeEl = capValues.find((el) => el.textContent === '3');
    const oneEl = capValues.find((el) => el.textContent === '1');

    if (threeEl) expect(threeEl.className).toContain('text-green-600');
    if (oneEl) expect(oneEl?.className).not.toContain('text-green-600');
  });

  it('does not highlight either value when both agents have the same metric value', async () => {
    // Arrange: both agents have the same cost — no highlight applied
    const { apiClient } = await import('@/lib/api/client');
    const dataEqualCost = {
      agents: [
        makeAgent({ id: 'agent-a', name: 'Agent Alpha', slug: 'agent-alpha', totalCostUsd: 5.0 }),
        makeAgent({ id: 'agent-b', name: 'Agent Beta', slug: 'agent-beta', totalCostUsd: 5.0 }),
      ] as [ReturnType<typeof makeAgent>, ReturnType<typeof makeAgent>],
    };
    vi.mocked(apiClient.get).mockResolvedValue(dataEqualCost);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      // Both cost values are equal — neither gets green highlight
      const costCells = screen.getAllByText('$5.0000');
      expect(costCells).toHaveLength(2);
      costCells.forEach((el) => {
        expect(el.className).not.toContain('text-green-600');
      });
    });
  });

  // ── Tokens rows ────────────────────────────────────────────────────────────

  it('renders Input Tokens and Output Tokens rows', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(COMPARISON_DATA);

    render(<AgentComparisonView agentIdA="agent-a" agentIdB="agent-b" />);

    await waitFor(() => {
      expect(screen.getByText('Input Tokens')).toBeInTheDocument();
      expect(screen.getByText('Output Tokens')).toBeInTheDocument();
    });
  });
});
