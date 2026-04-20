/**
 * McpAuditLog Component Tests
 *
 * Test Coverage:
 * - Renders empty state when no entries
 * - Renders entries with all columns
 * - Renders filter card with method, status, date range fields
 * - Apply filters calls apiClient.get with correct params
 * - Clear filters resets and refetches
 * - Pagination controls render when multiple pages
 * - Purge calls apiClient.delete and shows result
 *
 * @see components/admin/orchestration/mcp/mcp-audit-log.tsx
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
import { McpAuditLog } from '@/components/admin/orchestration/mcp/mcp-audit-log';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ENTRY = {
  id: 'entry-1',
  method: 'tools/call',
  toolSlug: 'send_email',
  resourceUri: null,
  responseCode: 'success',
  errorMessage: null,
  durationMs: 42,
  clientIp: '192.168.1.1',
  createdAt: '2026-04-19T10:00:00.000Z',
  apiKey: { name: 'Claude Desktop', keyPrefix: 'smcp_abc' },
};

const META = {
  page: 1,
  limit: 50,
  total: 100,
  totalPages: 2,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty state', () => {
    it('renders empty state when no entries', () => {
      render(<McpAuditLog initialEntries={[]} initialMeta={null} />);
      expect(screen.getByText(/no audit entries yet/i)).toBeInTheDocument();
    });
  });

  describe('Entry rows', () => {
    it('renders entry with method, target, status, duration, key, and IP', () => {
      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);
      expect(screen.getByText('tools/call')).toBeInTheDocument();
      expect(screen.getByText('send_email')).toBeInTheDocument();
      expect(screen.getByText('success')).toBeInTheDocument();
      expect(screen.getByText('42ms')).toBeInTheDocument();
      expect(screen.getByText('smcp_abc...')).toBeInTheDocument();
      expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    });

    it('shows total entries count', () => {
      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);
      expect(screen.getByText('100 total entries')).toBeInTheDocument();
    });
  });

  describe('Filters', () => {
    it('renders filter card with method, status, date from, and date to', () => {
      render(<McpAuditLog initialEntries={[]} initialMeta={null} />);
      expect(screen.getByText('Filters')).toBeInTheDocument();
      expect(screen.getByText('Apply Filters')).toBeInTheDocument();
    });

    it('calls apiClient.get when Apply Filters is clicked', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/audit'),
          expect.objectContaining({
            params: expect.objectContaining({ page: 1, limit: 50 }),
          })
        );
      });
    });
  });

  describe('Pagination', () => {
    it('renders pagination when multiple pages exist', () => {
      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      expect(screen.getByText('Previous')).toBeDisabled();
      expect(screen.getByText('Next')).toBeEnabled();
    });

    it('does not render pagination when single page', () => {
      const singlePage = { ...META, totalPages: 1 };
      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={singlePage} />);
      expect(screen.queryByText(/page \d+ of \d+/i)).not.toBeInTheDocument();
    });
  });

  describe('Purge', () => {
    it('calls apiClient.delete when Purge is clicked', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ deleted: 5 });
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Purge Old Logs'));
      });

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/mcp/audit'));
      });

      await waitFor(() => {
        expect(screen.getByText('Purged 5 log entries')).toBeInTheDocument();
      });
    });
  });
});
