/**
 * McpSessionsList Component Tests
 *
 * Test Coverage:
 * - Renders empty state when no sessions
 * - Renders session rows with ID, key ID, status, timestamps
 * - Refresh button calls apiClient.get and updates list
 * - Shows session count
 *
 * @see components/admin/orchestration/mcp/mcp-sessions-list.tsx
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
}));

import { apiClient } from '@/lib/api/client';
import { McpSessionsList } from '@/components/admin/orchestration/mcp/mcp-sessions-list';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION = {
  id: 'session-abc-def-123-456',
  apiKeyId: 'key-abc-def-789-012',
  initialized: true,
  createdAt: Date.now() - 300_000, // 5 min ago
  lastActivityAt: Date.now() - 30_000, // 30s ago
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpSessionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty state', () => {
    it('renders empty state when no sessions', () => {
      render(<McpSessionsList initialSessions={[]} />);
      expect(screen.getByText(/no active sessions/i)).toBeInTheDocument();
      expect(screen.getByText('0 active sessions')).toBeInTheDocument();
    });
  });

  describe('Session rows', () => {
    it('renders session with truncated IDs and Initialized badge', () => {
      render(<McpSessionsList initialSessions={[SESSION]} />);
      expect(screen.getByText('session-...')).toBeInTheDocument();
      expect(screen.getByText('key-abc-...')).toBeInTheDocument();
      expect(screen.getByText('Initialized')).toBeInTheDocument();
    });

    it('renders Pending badge for uninitialized session', () => {
      const pending = { ...SESSION, initialized: false };
      render(<McpSessionsList initialSessions={[pending]} />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('shows session count', () => {
      render(<McpSessionsList initialSessions={[SESSION]} />);
      expect(screen.getByText('1 active session')).toBeInTheDocument();
    });
  });

  describe('Refresh', () => {
    it('calls apiClient.get when Refresh is clicked', async () => {
      vi.mocked(apiClient.get).mockResolvedValue([]);

      render(<McpSessionsList initialSessions={[SESSION]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Refresh'));
      });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/mcp/sessions'));
      });
    });
  });
});
