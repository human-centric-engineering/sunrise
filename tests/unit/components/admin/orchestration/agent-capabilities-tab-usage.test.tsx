/**
 * AgentCapabilitiesTab — Usage Badge Tests
 *
 * Tests the usage badge display added in Phase 4 to the AgentCapabilitiesTab.
 * Exercises the `usageBadge()` internal function via rendered output.
 *
 * Test Coverage:
 * - No usage data and no rate limit: badge is not rendered for zero-call capability
 * - Usage with rate limit configured: shows "12 / 60 /min" format
 * - Usage at >= 80% of limit: amber styling (text-amber-600)
 * - Usage at >= 100% of limit: red styling (text-red-600)
 * - Usage with no rate limit (calls > 0): shows "{n} calls/min" format
 * - Auto-refresh: setInterval is called with a 15-second interval
 *
 * @see components/admin/orchestration/agent-capabilities-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

import { AgentCapabilitiesTab } from '@/components/admin/orchestration/agent-capabilities-tab';

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

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

function makeCapability(id: string, slug: string, name: string, rateLimit: number | null = null) {
  return {
    id,
    name,
    slug,
    description: `${name} description`,
    isActive: true,
    type: 'TOOL' as const,
    handler: null,
    config: {},
    rateLimit,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

function makeLink(
  id: string,
  capability: ReturnType<typeof makeCapability>,
  customRateLimit: number | null = null
) {
  return {
    id,
    agentId: AGENT_ID,
    capabilityId: capability.id,
    isEnabled: true,
    customConfig: null,
    customRateLimit,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    capability,
  };
}

/**
 * Sets up apiClient.get to:
 *  - Return `links` for the per-agent capabilities path
 *  - Return an empty array for the capability catalogue
 *  - Return `{ usage }` for the usage path
 */
function mockFetches(
  getMock: Mock,
  links: ReturnType<typeof makeLink>[],
  catalogue: ReturnType<typeof makeCapability>[],
  usage: Record<string, number>
) {
  getMock.mockImplementation((url: string) => {
    // Usage path ends with /capabilities/usage
    if (url.endsWith('/usage')) {
      return Promise.resolve({ usage });
    }
    // Per-agent capabilities: path contains /agents/:id/capabilities (not /usage)
    if (url.includes('/agents/')) {
      return Promise.resolve(links);
    }
    // Catalogue: /api/v1/admin/orchestration/capabilities
    return Promise.resolve(catalogue);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentCapabilitiesTab — usage badges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use real timers by default; individual tests override as needed
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── No badge when zero calls and no rate limit ─────────────────────────────

  describe('zero calls with no rate limit', () => {
    it('does not render a badge for a zero-usage capability with no rate limit', async () => {
      // Arrange: one attached capability, zero calls, no rate limit
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', null);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 0 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: capability name appears but no badge text
      await waitFor(() => {
        expect(screen.getByText('Web Search')).toBeInTheDocument();
      });

      // No "calls/min" or "/ X /min" badge rendered
      expect(screen.queryByText(/calls\/min/i)).toBeNull();
      expect(screen.queryByText(/\/ \d+ \/min/)).toBeNull();
    });
  });

  // ── Badge format with rate limit ──────────────────────────────────────────

  describe('usage with rate limit configured', () => {
    it('renders "{calls} / {limit} /min" badge when calls < 80% of limit', async () => {
      // Arrange: 12 calls out of a 60/min limit → 20% utilisation
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 12 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/12 \/ 60 \/min/)).toBeInTheDocument();
      });
    });

    it('renders amber styling when usage is >= 80% of the rate limit', async () => {
      // Arrange: 48 calls out of 60 → 80% exactly
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 48 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: badge exists with amber colour class
      await waitFor(() => {
        const badge = screen.getByText(/48 \/ 60 \/min/);
        expect(badge).toBeInTheDocument();
        // The badge element or a parent should have the amber class
        const badgeOrParent = badge.classList.contains('text-amber-600')
          ? badge
          : badge.closest('.text-amber-600');
        expect(badgeOrParent).toBeTruthy();
      });
    });

    it('renders amber styling when usage is > 80% but < 100% of the rate limit', async () => {
      // Arrange: 54 calls out of 60 → 90%
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 54 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        const badge = screen.getByText(/54 \/ 60 \/min/);
        const coloured = badge.classList.contains('text-amber-600')
          ? badge
          : badge.closest('.text-amber-600');
        expect(coloured).toBeTruthy();
      });
    });

    it('renders red styling when usage is >= 100% of the rate limit', async () => {
      // Arrange: 60 calls out of 60 → 100% (at limit)
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 60 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: badge has red colour class
      await waitFor(() => {
        const badge = screen.getByText(/60 \/ 60 \/min/);
        const coloured = badge.classList.contains('text-red-600')
          ? badge
          : badge.closest('.text-red-600');
        expect(coloured).toBeTruthy();
      });
    });

    it('renders red styling when usage exceeds the rate limit', async () => {
      // Arrange: 75 calls out of 60 → 125% (over limit)
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 75 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        const badge = screen.getByText(/75 \/ 60 \/min/);
        const coloured = badge.classList.contains('text-red-600')
          ? badge
          : badge.closest('.text-red-600');
        expect(coloured).toBeTruthy();
      });
    });

    it('uses the customRateLimit on the link instead of the capability default', async () => {
      // Arrange: capability default is 60; link overrides to 20
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', 60);
      const link = makeLink('link-1', cap, 20); // customRateLimit = 20
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 16 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: badge shows "{calls} / 20 /min" (custom limit, not 60)
      await waitFor(() => {
        expect(screen.getByText(/16 \/ 20 \/min/)).toBeInTheDocument();
      });
    });
  });

  // ── Badge format without rate limit ───────────────────────────────────────

  describe('usage with no rate limit configured', () => {
    it('renders "{calls} calls/min" badge when calls > 0 and no rate limit', async () => {
      // Arrange: 5 calls, no rate limit on capability or link
      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', null);
      const link = makeLink('link-1', cap, null);
      mockFetches(vi.mocked(apiClient.get), [link], [], { 'web-search': 5 });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('5 calls/min')).toBeInTheDocument();
      });
    });
  });

  // ── Auto-refresh interval ─────────────────────────────────────────────────

  describe('auto-refresh', () => {
    it('calls setInterval with a 15-second interval on mount', async () => {
      // Arrange: use fake timers to intercept setInterval
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', null);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], {});

      // Act: wrap in act so async state updates from the initial fetch are flushed
      await act(async () => {
        render(<AgentCapabilitiesTab agentId={AGENT_ID} />);
        // Allow microtasks (Promise chains from apiClient.get) to settle
        await Promise.resolve();
      });

      // Assert: setInterval called with exactly 15,000 ms
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    });

    it('triggers an additional usage fetch after the 15-second interval', async () => {
      // Arrange
      vi.useFakeTimers();

      const { apiClient } = await import('@/lib/api/client');
      const cap = makeCapability('cap-1', 'web-search', 'Web Search', null);
      const link = makeLink('link-1', cap);
      mockFetches(vi.mocked(apiClient.get), [link], [], {});

      // Render and let initial async fetches settle inside act()
      await act(async () => {
        render(<AgentCapabilitiesTab agentId={AGENT_ID} />);
        await Promise.resolve();
      });

      // Count calls after initial mount is settled
      const initialCallCount = vi.mocked(apiClient.get).mock.calls.length;

      // Act: advance timers by 15 seconds to trigger the interval callback
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      // Assert: at least one more call was made for the usage refresh
      expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });
});
