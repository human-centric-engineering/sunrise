/**
 * McpDashboard Component Tests
 *
 * Test Coverage:
 * - Renders server status card with toggle
 * - Shows enabled/disabled badge based on settings
 * - Renders all 6 quick link cards
 * - Shows connection config snippet when enabled
 * - Hides connection config when disabled
 * - Shows getting started wizard when no tools/keys
 * - Hides getting started wizard when tools/keys exist
 * - Toggle calls apiClient.patch and updates state
 *
 * @see components/admin/orchestration/mcp/mcp-dashboard.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

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
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient } from '@/lib/api/client';
import { McpDashboard } from '@/components/admin/orchestration/mcp/mcp-dashboard';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ENABLED_SETTINGS = {
  isEnabled: true,
  serverName: 'Sunrise MCP Server',
  serverVersion: '1.0.0',
  maxSessionsPerKey: 5,
  globalRateLimit: 60,
  auditRetentionDays: 90,
};

const DISABLED_SETTINGS = {
  ...ENABLED_SETTINGS,
  isEnabled: false,
};

const STATS_WITH_DATA = { tools: 3, resources: 2, keys: 1 };
const STATS_EMPTY = { tools: 0, resources: 0, keys: 0 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Server status', () => {
    it('renders Server Status card with Enabled badge when server is enabled', () => {
      render(<McpDashboard initialSettings={ENABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByText('Server Status')).toBeInTheDocument();
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });

    it('renders Disabled badge when server is disabled', () => {
      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });

    it('renders the enable/disable switch', () => {
      render(<McpDashboard initialSettings={ENABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByRole('switch', { name: /enable mcp server/i })).toBeInTheDocument();
    });
  });

  describe('Quick links', () => {
    it('renders all 6 quick link cards including Sessions', () => {
      render(<McpDashboard initialSettings={ENABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByText('Exposed Tools')).toBeInTheDocument();
      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText('API Keys')).toBeInTheDocument();
      expect(screen.getByText('Sessions')).toBeInTheDocument();
      expect(screen.getByText('Audit Log')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('shows count badges for tools, resources, and keys', () => {
      render(<McpDashboard initialSettings={ENABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  describe('Connection config', () => {
    it('shows client configuration snippet when server is enabled', () => {
      render(<McpDashboard initialSettings={ENABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.getByText('Client Configuration')).toBeInTheDocument();
      expect(screen.getByText(/mcpServers/)).toBeInTheDocument();
    });

    it('hides client configuration when server is disabled', () => {
      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.queryByText('Client Configuration')).not.toBeInTheDocument();
    });
  });

  describe('Getting started', () => {
    it('shows getting started wizard when no tools and no keys', () => {
      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_EMPTY} />);
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    it('hides getting started when tools or keys exist', () => {
      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();
    });
  });

  describe('Toggle', () => {
    it('calls apiClient.patch when toggle is clicked', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue(ENABLED_SETTINGS);

      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      const toggle = screen.getByRole('switch', { name: /enable mcp server/i });

      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/settings'),
          expect.objectContaining({ body: { isEnabled: true } })
        );
      });
    });

    it('reverts state when toggle API call fails', async () => {
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('fail'));

      render(<McpDashboard initialSettings={DISABLED_SETTINGS} stats={STATS_WITH_DATA} />);
      const toggle = screen.getByRole('switch', { name: /enable mcp server/i });

      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Disabled')).toBeInTheDocument();
      });
    });
  });
});
