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
        expect(apiClient.get).toHaveBeenCalledTimes(4); // 2 initial + 2 refetch
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
          expect.stringContaining('/capabilities/link-1')
        );
        expect(apiClient.get).toHaveBeenCalledTimes(4); // 2 initial + 2 refetch
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
          expect.stringContaining('/capabilities/link-1'),
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
          expect.stringContaining('/capabilities/link-1'),
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
});
