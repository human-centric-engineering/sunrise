/**
 * AgentCapabilitiesTab Component Tests
 *
 * Test Coverage:
 * - Two-column render (Attached / Available)
 * - Attach → POST + refetch updates left column
 * - Detach → DELETE + refetch removes from left column
 * - Toggle Switch → PATCH with { isEnabled }
 * - Configure dialog saves customConfig + customRateLimit via PATCH
 *
 * @see components/admin/orchestration/agent-capabilities-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

function makeCapability(id: string, name: string, slug: string) {
  return {
    id,
    name,
    slug,
    description: `${name} description`,
    isActive: true,
    type: 'TOOL' as const,
    handler: null,
    config: {},
    rateLimit: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

function makeLink(id: string, capabilityId: string, capName: string, capSlug: string) {
  return {
    id,
    agentId: AGENT_ID,
    capabilityId,
    isEnabled: true,
    customConfig: null,
    customRateLimit: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    capability: makeCapability(capabilityId, capName, capSlug),
  };
}

const CAP_SEARCH = makeCapability('cap-search', 'Web Search', 'web-search');
const CAP_CALC = makeCapability('cap-calc', 'Calculator', 'calculator');
const LINK_SEARCH = makeLink('link-1', 'cap-search', 'Web Search', 'web-search');

// Default mock: one attached (Web Search), one available (Calculator)
// Agent capabilities path: /api/v1/admin/orchestration/agents/:id/capabilities
// Catalogue path:          /api/v1/admin/orchestration/capabilities
function mockDefaultFetch(getMock: Mock) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/agents/')) {
      // Per-agent capabilities (attached links) — path contains /agents/:id/capabilities
      return Promise.resolve([LINK_SEARCH]);
    }
    // Capability catalogue — /api/v1/admin/orchestration/capabilities
    return Promise.resolve([CAP_SEARCH, CAP_CALC]);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentCapabilitiesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Two-column render ─────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders Attached and Available section headers', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Attached')).toBeInTheDocument();
        expect(screen.getByText('Available')).toBeInTheDocument();
      });
    });

    it('renders attached capability name in left column', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Web Search')).toBeInTheDocument();
      });
    });

    it('renders available capability name in right column', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: Calculator is available (not attached)
      await waitFor(() => {
        expect(screen.getByText('Calculator')).toBeInTheDocument();
      });
    });

    it('shows "No capabilities attached yet" when none attached', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/agents/')) return Promise.resolve([]);
        return Promise.resolve([CAP_SEARCH, CAP_CALC]);
      });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/no capabilities attached yet/i)).toBeInTheDocument();
      });
    });

    it('shows "Every capability is already attached" when all attached', async () => {
      // Arrange — both capabilities are attached
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/agents/')) {
          return Promise.resolve([
            LINK_SEARCH,
            makeLink('link-2', 'cap-calc', 'Calculator', 'calculator'),
          ]);
        }
        return Promise.resolve([CAP_SEARCH, CAP_CALC]);
      });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/every capability is already attached/i)).toBeInTheDocument();
      });
    });
  });

  // ── Attach ────────────────────────────────────────────────────────────────

  describe('attach', () => {
    it('Attach button POSTs with capabilityId then refetches', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.post).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Calculator')).toBeInTheDocument());

      // Act: click Attach next to Calculator
      await user.click(screen.getByRole('button', { name: /attach/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities'),
          expect.objectContaining({ body: { capabilityId: 'cap-calc' } })
        );
        // refetch was called (get called more than initial 2 times)
        // 2 initial + 2 refetch + 1 usage badge fetch = 5
        expect(apiClient.get).toHaveBeenCalledTimes(5);
      });
    });
  });

  // ── Detach ────────────────────────────────────────────────────────────────

  describe('detach', () => {
    it('Detach button calls DELETE then refetches', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act: click Detach
      await user.click(screen.getByRole('button', { name: /detach/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities/cap-search')
        );
        // 2 initial + 2 refetch + 1 usage badge fetch = 5
        expect(apiClient.get).toHaveBeenCalledTimes(5);
      });
    });
  });

  // ── Toggle isEnabled ──────────────────────────────────────────────────────

  describe('toggle isEnabled', () => {
    it('Switch sends PATCH with isEnabled', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act: click the Switch for the attached capability
      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      // Assert: PATCH with isEnabled: false (was true → toggled to false)
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities/cap-search'),
          expect.objectContaining({ body: { isEnabled: false } })
        );
      });
    });
  });

  // ── Configure dialog ──────────────────────────────────────────────────────

  describe('configure dialog', () => {
    it('opens configure dialog on Configure click', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act
      await user.click(screen.getByRole('button', { name: /configure/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/configure web search/i)).toBeInTheDocument();
      });
    });

    it('saves customConfig and customRateLimit via PATCH', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act: open dialog, fill in config and rate limit, save
      await user.click(screen.getByRole('button', { name: /configure/i }));
      await waitFor(() => expect(screen.getByText(/configure web search/i)).toBeInTheDocument());

      const configArea = screen.getByRole('textbox', { name: /custom config/i });
      await user.clear(configArea);
      // Use clipboard paste to avoid userEvent special character issues with { }
      await user.click(configArea);
      await user.paste('{"maxResults":10}');

      const rateLimitInput = screen.getByRole('spinbutton', { name: /custom rate limit/i });
      await user.clear(rateLimitInput);
      await user.type(rateLimitInput, '60');

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities/cap-search'),
          expect.objectContaining({
            body: expect.objectContaining({
              customConfig: { maxResults: 10 },
              customRateLimit: 60,
            }),
          })
        );
      });
    });
  });

  // ── Error / empty-state edge cases ────────────────────────────────────────

  describe('error and edge-case paths', () => {
    it('renders inline error banner when initial apiClient.get rejects', async () => {
      // Arrange: both fetches reject
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Network error', 'SERVICE_UNAVAILABLE', 503)
      );

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: error banner appears, layout is preserved (no throw)
      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });

      // Both column headings still rendered (layout intact)
      expect(screen.getByText('Attached')).toBeInTheDocument();
      expect(screen.getByText('Available')).toBeInTheDocument();
    });

    it('renders "No capabilities attached yet" when agent capabilities fetch returns empty array', async () => {
      // Arrange: agent capabilities = [], catalogue has one item
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/agents/')) return Promise.resolve([]);
        return Promise.resolve([CAP_SEARCH]);
      });

      // Act
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: left column empty state
      await waitFor(() => {
        expect(screen.getByText(/no capabilities attached yet/i)).toBeInTheDocument();
      });
    });

    it('renders inline error when Attach POST fails', async () => {
      // Arrange: initial fetch succeeds; POST fails
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Attach failed', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Calculator')).toBeInTheDocument());

      // Act: click Attach
      await user.click(screen.getByRole('button', { name: /attach/i }));

      // Assert: inline error message
      await waitFor(() => {
        expect(screen.getByText(/attach failed/i)).toBeInTheDocument();
      });
    });

    it('renders generic fallback message when Detach DELETE rejects with a non-APIClientError', async () => {
      // Arrange: initial fetch succeeds; DELETE throws a plain Error
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('timeout'));

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act: click Detach
      await user.click(screen.getByRole('button', { name: /detach/i }));

      // Assert: generic fallback message (not the plain Error message)
      await waitFor(() => {
        expect(screen.getByText(/could not detach capability/i)).toBeInTheDocument();
      });
    });

    it('renders generic fallback message when Toggle PATCH rejects with a non-APIClientError', async () => {
      // Arrange: initial fetch succeeds; PATCH throws a plain Error
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('connection refused'));

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      // Act: click the Switch
      const switches = screen.getAllByRole('switch');
      await user.click(switches[0]);

      // Assert: generic fallback message
      await waitFor(() => {
        expect(screen.getByText(/could not update capability/i)).toBeInTheDocument();
      });
    });
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      // Arrange: never resolve
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

      // Act
      const { container } = render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Assert: spinner visible, no columns rendered yet
      expect(container.querySelector('.animate-spin')).toBeInTheDocument();
      expect(screen.queryByText('Attached')).not.toBeInTheDocument();
    });
  });

  // ── usageBadge branches ───────────────────────────────────────────────────

  describe('usageBadge display', () => {
    function makeUsageLink(capabilityId: string, slug: string) {
      return makeLink('link-u', capabilityId, 'Test Cap', slug);
    }

    it('shows no badge when limit is null and calls is 0', async () => {
      // Arrange: link has null rateLimit, capability has null rateLimit → calls=0
      const { apiClient } = await import('@/lib/api/client');
      const capNoLimit = makeCapability('cap-no-limit', 'No Limit Cap', 'no-limit');
      const linkNoLimit = { ...makeUsageLink('cap-no-limit', 'no-limit'), capability: capNoLimit };

      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/agents/')) return Promise.resolve([linkNoLimit]);
        return Promise.resolve([capNoLimit]);
      });
      // usage fetch returns 0 calls for the slug
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/usage')) return Promise.resolve({ usage: { 'no-limit': 0 } });
        if (url.includes('/agents/')) return Promise.resolve([linkNoLimit]);
        return Promise.resolve([capNoLimit]);
      });

      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('No Limit Cap')).toBeInTheDocument());

      // No calls/min badge rendered — usageBadge returned null
      expect(screen.queryByText(/calls\/min/i)).not.toBeInTheDocument();
    });

    it('shows calls/min badge when limit is null but calls > 0', async () => {
      // Arrange: no rate limit, but 5 calls made
      const { apiClient } = await import('@/lib/api/client');
      const capNoLimit = makeCapability('cap-active', 'Active Cap', 'active-cap');
      const linkNoLimit = {
        ...makeLink('link-a', 'cap-active', 'Active Cap', 'active-cap'),
        capability: capNoLimit,
      };

      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/usage')) return Promise.resolve({ usage: { 'active-cap': 5 } });
        if (url.includes('/agents/')) return Promise.resolve([linkNoLimit]);
        return Promise.resolve([capNoLimit]);
      });

      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText(/5 calls\/min/i)).toBeInTheDocument());
    });

    it('shows red badge text when usage is at or above the rate limit', async () => {
      // Arrange: rateLimit=10, calls=10 → ratio=1 → red
      const { apiClient } = await import('@/lib/api/client');
      const capLimited = {
        ...makeCapability('cap-limit', 'Limited Cap', 'limited-cap'),
        rateLimit: 10,
      };
      const linkLimited = {
        ...makeLink('link-l', 'cap-limit', 'Limited Cap', 'limited-cap'),
        customRateLimit: null,
        capability: capLimited,
      };

      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/usage')) return Promise.resolve({ usage: { 'limited-cap': 10 } });
        if (url.includes('/agents/')) return Promise.resolve([linkLimited]);
        return Promise.resolve([capLimited]);
      });

      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // Badge shows "10 / 10 /min"
      await waitFor(() => expect(screen.getByText('10 / 10 /min')).toBeInTheDocument());

      // Badge element has red color class
      const badge = screen.getByText('10 / 10 /min');
      expect(badge.className).toContain('text-red-600');
    });

    it('shows amber badge text when usage is between 80% and 100% of rate limit', async () => {
      // Arrange: rateLimit=10, calls=8 → ratio=0.8 → amber
      const { apiClient } = await import('@/lib/api/client');
      const capAmber = { ...makeCapability('cap-amber', 'Amber Cap', 'amber-cap'), rateLimit: 10 };
      const linkAmber = {
        ...makeLink('link-am', 'cap-amber', 'Amber Cap', 'amber-cap'),
        customRateLimit: null,
        capability: capAmber,
      };

      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/usage')) return Promise.resolve({ usage: { 'amber-cap': 8 } });
        if (url.includes('/agents/')) return Promise.resolve([linkAmber]);
        return Promise.resolve([capAmber]);
      });

      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('8 / 10 /min')).toBeInTheDocument());

      const badge = screen.getByText('8 / 10 /min');
      expect(badge.className).toContain('text-amber-600');
    });

    it('customRateLimit overrides capability rateLimit in usageBadge', async () => {
      // Arrange: capability.rateLimit=100, customRateLimit=5, calls=5 → ratio=1 → red
      const { apiClient } = await import('@/lib/api/client');
      const capHighLimit = {
        ...makeCapability('cap-hl', 'High Limit Cap', 'hl-cap'),
        rateLimit: 100,
      };
      const linkCustom = {
        ...makeLink('link-c', 'cap-hl', 'High Limit Cap', 'hl-cap'),
        customRateLimit: 5,
        capability: capHighLimit,
      };

      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/usage')) return Promise.resolve({ usage: { 'hl-cap': 5 } });
        if (url.includes('/agents/')) return Promise.resolve([linkCustom]);
        return Promise.resolve([capHighLimit]);
      });

      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      // customRateLimit=5 is used, so ratio = 5/5 = 1 → red badge
      await waitFor(() => expect(screen.getByText('5 / 5 /min')).toBeInTheDocument());

      const badge = screen.getByText('5 / 5 /min');
      expect(badge.className).toContain('text-red-600');
    });
  });

  // ── Configure dialog — validation branches ────────────────────────────────

  describe('configure dialog validation', () => {
    it('shows JSON parse error when customConfig is invalid JSON', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /configure/i }));
      await waitFor(() => expect(screen.getByText(/configure web search/i)).toBeInTheDocument());

      // Act: type invalid JSON into config textarea
      const configArea = screen.getByRole('textbox', { name: /custom config/i });
      await user.clear(configArea);
      await user.type(configArea, 'not-valid-json');

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // Assert: JSON error shown, PATCH not called
      await waitFor(() => {
        expect(screen.getByText(/not valid json/i)).toBeInTheDocument();
      });
      expect(apiClient.patch).not.toHaveBeenCalled();
    });

    it('shows rate limit error when customRateLimit is not a positive number', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /configure/i }));
      await waitFor(() => expect(screen.getByText(/configure web search/i)).toBeInTheDocument());

      // Act: type invalid rate limit (0 is not a positive number)
      const rateLimitInput = screen.getByRole('spinbutton', { name: /custom rate limit/i });
      await user.clear(rateLimitInput);
      await user.type(rateLimitInput, '0');

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // Assert: rate limit validation error shown
      await waitFor(() => {
        expect(screen.getByText(/rate limit must be a positive number/i)).toBeInTheDocument();
      });
      expect(apiClient.patch).not.toHaveBeenCalled();
    });

    it('shows error message from APIClientError when save PATCH fails', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      mockDefaultFetch(vi.mocked(apiClient.get));
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Capability not found', 'NOT_FOUND', 404)
      );

      const user = userEvent.setup();
      render(<AgentCapabilitiesTab agentId={AGENT_ID} />);

      await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /configure/i }));
      await waitFor(() => expect(screen.getByText(/configure web search/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // Assert: APIClientError message shown in dialog
      await waitFor(() => {
        expect(screen.getByText(/capability not found/i)).toBeInTheDocument();
      });
    });
  });
});
