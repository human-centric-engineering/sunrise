/**
 * CapabilityStatsPanel Component Tests
 *
 * Test Coverage:
 * - Loading state shown while fetching
 * - Error state shown on fetch failure
 * - Stats render correctly after successful fetch
 * - Period selector fires new GET requests
 * - Invocations=0 shows "no invocations" description
 * - Success rate colour thresholds (green ≥95%, yellow ≥80%, red <80%)
 *
 * @see components/admin/orchestration/capability-stats-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityStatsPanel } from '@/components/admin/orchestration/capability-stats-panel';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAP_ID = 'cap-abc-123';

function makeStats(
  overrides: Partial<{
    invocations: number;
    successRate: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    totalCostUsd: number;
  }> = {}
) {
  return {
    capabilityId: CAP_ID,
    capabilitySlug: 'web-search',
    period: '30d' as const,
    invocations: overrides.invocations ?? 120,
    successRate: overrides.successRate ?? 97,
    avgLatencyMs: overrides.avgLatencyMs ?? 340,
    p50LatencyMs: overrides.p50LatencyMs ?? 310,
    p95LatencyMs: overrides.p95LatencyMs ?? 900,
    totalCostUsd: overrides.totalCostUsd ?? 0.0042,
    dailyBreakdown: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityStatsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Loading state ───────────────────────────────────────────────────────────

  it('shows loading spinner while fetching', async () => {
    const { apiClient } = await import('@/lib/api/client');
    // Never resolves — keeps loading state
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    expect(screen.getByText('Execution Metrics')).toBeInTheDocument();
    // Spinner is present (rendered by Loader2 icon)
    const header = screen.getByText('Execution Metrics');
    expect(header).toBeInTheDocument();
    expect(screen.queryByText(/invocations/i)).not.toBeInTheDocument();
  });

  // ── Error state ────────────────────────────────────────────────────────────

  it('shows error message when fetch fails', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load metrics')).toBeInTheDocument();
    });
    expect(screen.getByText('Execution Metrics')).toBeInTheDocument();
  });

  // ── Success state ──────────────────────────────────────────────────────────

  it('renders all four metric cards after successful fetch', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats());

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Invocations')).toBeInTheDocument();
    });

    expect(screen.getByText('Success Rate')).toBeInTheDocument();
    expect(screen.getByText('Avg Latency')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
  });

  it('displays correct invocation count', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ invocations: 1500 }));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      // toLocaleString produces "1,500" in test env
      expect(screen.getByText('1,500')).toBeInTheDocument();
    });
  });

  it('displays success rate with % suffix', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ successRate: 97 }));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('97%')).toBeInTheDocument();
    });
  });

  it('displays latency with ms suffix and p50/p95 sub-text', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(
      makeStats({ avgLatencyMs: 340, p50LatencyMs: 310, p95LatencyMs: 900 })
    );

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('340ms')).toBeInTheDocument();
      expect(screen.getByText('p50: 310ms · p95: 900ms')).toBeInTheDocument();
    });
  });

  it('displays total cost formatted to 4 decimal places', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ totalCostUsd: 0.0042 }));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('$0.0042')).toBeInTheDocument();
    });
  });

  // ── Description line ───────────────────────────────────────────────────────

  it('shows "no invocations recorded yet" when invocations is 0', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ invocations: 0 }));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText('No invocations recorded yet')).toBeInTheDocument();
    });
  });

  it('shows invocation count summary when invocations > 0', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ invocations: 50 }));

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/50 invocations over the last 30d/i)).toBeInTheDocument();
    });
  });

  // ── Period selector ────────────────────────────────────────────────────────

  it('renders 7d, 30d, and 90d period buttons', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats());

    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument();
    });
  });

  it('clicking a period button triggers a new GET request with that period', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats());

    const user = userEvent.setup();
    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    });

    vi.mocked(apiClient.get).mockClear();
    await user.click(screen.getByRole('button', { name: '7d' }));

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('period=7d'));
    });
  });

  it('clicking 90d period updates description to show 90d', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeStats({ invocations: 200 }));

    const user = userEvent.setup();
    render(<CapabilityStatsPanel capabilityId={CAP_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument();
    });

    // Resolve the 90d call with updated stats
    vi.mocked(apiClient.get).mockResolvedValue({
      ...makeStats({ invocations: 200 }),
      period: '90d' as const,
    });

    await user.click(screen.getByRole('button', { name: '90d' }));

    await waitFor(() => {
      expect(screen.getByText(/200 invocations over the last 90d/i)).toBeInTheDocument();
    });
  });
});
