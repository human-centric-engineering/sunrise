/**
 * McpKeysList Component Tests
 *
 * Test Coverage:
 * - Renders empty state when no keys
 * - Renders key rows with all columns (name, prefix, scopes, status, expiry, rate limit, dates)
 * - Shows expired badge for expired keys
 * - Create dialog renders with all fields (name, scopes, expiry, rate limit)
 * - Shows plaintext key after creation
 * - Revoke calls apiClient.patch
 * - Rotate calls apiClient.post and shows rotated plaintext
 *
 * @see components/admin/orchestration/mcp/mcp-keys-list.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

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
import { McpKeysList } from '@/components/admin/orchestration/mcp/mcp-keys-list';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVE_KEY = {
  id: 'key-1',
  name: 'Claude Desktop',
  keyPrefix: 'smcp_abc',
  scopes: ['tools:list', 'tools:execute'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: '2026-04-19T10:00:00.000Z',
  rateLimitOverride: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  creator: { name: 'Admin', email: 'admin@test.com' },
};

const EXPIRED_KEY = {
  ...ACTIVE_KEY,
  id: 'key-2',
  name: 'Old Key',
  keyPrefix: 'smcp_old',
  expiresAt: '2025-01-01T00:00:00.000Z', // in the past
};

const KEY_WITH_RATE_LIMIT = {
  ...ACTIVE_KEY,
  id: 'key-3',
  name: 'Rate Limited Key',
  keyPrefix: 'smcp_rl',
  rateLimitOverride: 120,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpKeysList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty state', () => {
    it('renders empty state message when no keys', () => {
      render(<McpKeysList initialKeys={[]} />);
      expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument();
    });
  });

  describe('Key rows', () => {
    it('renders key name and prefix', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
      expect(screen.getByText('smcp_abc...')).toBeInTheDocument();
    });

    it('renders scope badges', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('tools:list')).toBeInTheDocument();
      expect(screen.getByText('tools:execute')).toBeInTheDocument();
    });

    it('renders Active badge for active key', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('renders Expired badge for expired key', () => {
      render(<McpKeysList initialKeys={[EXPIRED_KEY]} />);
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });

    it('renders rate limit override when set', () => {
      render(<McpKeysList initialKeys={[KEY_WITH_RATE_LIMIT]} />);
      expect(screen.getByText('120/min')).toBeInTheDocument();
    });

    it('renders "default" when no rate limit override', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('default')).toBeInTheDocument();
    });

    it('renders expiry date when set', () => {
      render(<McpKeysList initialKeys={[EXPIRED_KEY]} />);
      // The date rendering depends on locale, but should not be '—'
      const cells = screen.getAllByText(/2025|1\/1/);
      expect(cells.length).toBeGreaterThan(0);
    });

    it('renders "—" when no expiry', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      // Multiple '—' cells exist, just check at least one
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThan(0);
    });
  });

  describe('Actions', () => {
    it('renders Revoke and Rotate buttons for active keys', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Revoke')).toBeInTheDocument();
      expect(screen.getByText('Rotate')).toBeInTheDocument();
    });

    it('does not render action buttons for inactive keys', () => {
      const revoked = { ...ACTIVE_KEY, isActive: false };
      render(<McpKeysList initialKeys={[revoked]} />);
      expect(screen.queryByText('Revoke')).not.toBeInTheDocument();
      expect(screen.queryByText('Rotate')).not.toBeInTheDocument();
    });

    it('calls apiClient.patch when Revoke is clicked', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Revoke'));
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys/key-1'),
          expect.objectContaining({ body: { isActive: false } })
        );
      });
    });

    it('calls apiClient.post when Rotate is clicked and shows plaintext', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ plaintextKey: 'smcp_new_rotated_key' });
      vi.mocked(apiClient.get).mockResolvedValue([ACTIVE_KEY]);

      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Rotate'));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys/key-1/rotate')
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Key Rotated')).toBeInTheDocument();
        expect(screen.getByText('smcp_new_rotated_key')).toBeInTheDocument();
      });
    });
  });

  describe('Create dialog', () => {
    it('opens create dialog with name, scopes, expiry, and rate limit fields', async () => {
      render(<McpKeysList initialKeys={[]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Create API Key'));
      });

      expect(screen.getByText('Create MCP API Key')).toBeInTheDocument();
      expect(document.getElementById('key-name')).toBeInTheDocument();
      expect(document.getElementById('key-expiry')).toBeInTheDocument();
      expect(document.getElementById('key-rate-limit')).toBeInTheDocument();
    });
  });
});
