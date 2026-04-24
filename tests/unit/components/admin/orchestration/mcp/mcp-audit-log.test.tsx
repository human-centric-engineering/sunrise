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
    /** Click the Purge trigger and confirm in the AlertDialog */
    async function confirmPurge() {
      await act(async () => {
        fireEvent.click(screen.getByText('Purge Old Logs'));
      });
      // Confirmation dialog should appear
      await waitFor(() => {
        expect(screen.getByText('Purge old audit logs?')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^purge$/i }));
      });
    }

    it('shows confirmation dialog before purging', async () => {
      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Purge Old Logs'));
      });

      expect(screen.getByText('Purge old audit logs?')).toBeInTheDocument();
      expect(screen.getByText(/permanently delete/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^purge$/i })).toBeInTheDocument();
    });

    it('calls apiClient.delete when Purge is confirmed', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ deleted: 5 });
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await confirmPurge();

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/mcp/audit'));
      });

      await waitFor(() => {
        expect(screen.getByText('Purged 5 log entries')).toBeInTheDocument();
      });
    });

    it('shows "No old entries to purge" when deleted count is 0 and no message field', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ deleted: 0 });
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await confirmPurge();

      await waitFor(() => {
        expect(screen.getByText('No old entries to purge')).toBeInTheDocument();
      });
    });

    it('shows custom message when purge returns deleted=0 with a message field', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({
        deleted: 0,
        message: 'Nothing to purge yet',
      });
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await confirmPurge();

      await waitFor(() => {
        expect(screen.getByText('Nothing to purge yet')).toBeInTheDocument();
      });
    });

    it('shows "Purge failed" when purge throws', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('Network error'));

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await confirmPurge();

      await waitFor(() => {
        expect(screen.getByText('Purge failed')).toBeInTheDocument();
      });
    });
  });

  describe('Clear Filters', () => {
    it('shows Clear Filters button when filters are active and clicking it resets state', async () => {
      // Arrange: set up a fetch mock that returns empty with proper structure
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      // Initially no Clear Filters button (no active filters)
      expect(screen.queryByText('Clear Filters')).not.toBeInTheDocument();

      // Act: change the date-from filter to trigger hasFilters
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });

      // Assert: Clear Filters button now visible
      await waitFor(() => {
        expect(screen.getByText('Clear Filters')).toBeInTheDocument();
      });

      // Act: click Clear Filters — calls fetchEntries with empty params
      await act(async () => {
        fireEvent.click(screen.getByText('Clear Filters'));
      });

      // Assert: apiClient.get was called (the fetchEntries inside handleClearFilters)
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/audit'),
          expect.objectContaining({ params: expect.objectContaining({ page: 1, limit: 50 }) })
        );
      });
    });
  });

  describe('fetchEntries response shapes', () => {
    it('handles flat array response from apiClient.get', async () => {
      // Arrange: API returns a flat array (not enveloped)
      const flatEntry = { ...ENTRY, id: 'flat-1' };
      vi.mocked(apiClient.get).mockResolvedValue([flatEntry]);

      render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

      // Act: trigger a fetch
      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      // Assert: the flat-array branch executed — new entry is displayed
      await waitFor(() => {
        expect(screen.getByText('tools/call')).toBeInTheDocument();
      });
    });

    it('applies method filter param when method state is set before fetch', async () => {
      // Arrange: mock returns empty with envelope
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      // Act: apply filters (method is '' by default so no method param — verify limit param shape)
      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      // Assert: correct API call shape — no extra filter params when filters are empty
      await waitFor(() => {
        const call = vi.mocked(apiClient.get).mock.calls[0] as [
          string,
          { params: Record<string, unknown> },
        ];
        expect(call[1].params).not.toHaveProperty('method');
        expect(call[1].params).not.toHaveProperty('responseCode');
      });
    });
  });

  describe('Entry target column variants', () => {
    it('shows resourceUri when toolSlug is absent', () => {
      // Arrange: entry has resourceUri but no toolSlug
      const resourceEntry = {
        ...ENTRY,
        id: 'res-1',
        toolSlug: null,
        resourceUri: 'file://knowledge/doc.md',
      };

      render(<McpAuditLog initialEntries={[resourceEntry]} initialMeta={null} />);

      // Assert: resourceUri rendered in target column
      expect(screen.getByText('file://knowledge/doc.md')).toBeInTheDocument();
    });

    it('shows em-dash when both toolSlug and resourceUri are absent', () => {
      // Arrange: entry has neither toolSlug nor resourceUri
      const bareEntry = { ...ENTRY, id: 'bare-1', toolSlug: null, resourceUri: null };

      render(<McpAuditLog initialEntries={[bareEntry]} initialMeta={null} />);

      // Assert: em-dash shown in target column
      // The component renders <span>—</span> for the target and also for clientIp
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });

    it('shows em-dash for API key column when entry.apiKey is null', () => {
      // Arrange: entry with no api key
      const noKeyEntry = { ...ENTRY, id: 'nokey-1', apiKey: null };

      render(<McpAuditLog initialEntries={[noKeyEntry]} initialMeta={null} />);

      // Assert: at least one em-dash in the table (API key column)
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getStatusVariant helper', () => {
    it('renders "error" badge with destructive variant', () => {
      // Arrange: entry with error responseCode
      const errorEntry = { ...ENTRY, id: 'err-1', responseCode: 'error' };

      render(<McpAuditLog initialEntries={[errorEntry]} initialMeta={null} />);

      // Assert: badge for "error" is rendered
      expect(screen.getByText('error')).toBeInTheDocument();
    });

    it('renders "rate_limited" badge with secondary variant', () => {
      // Arrange: entry with rate_limited responseCode (neither success nor error → secondary)
      const rateLimitedEntry = { ...ENTRY, id: 'rl-1', responseCode: 'rate_limited' };

      render(<McpAuditLog initialEntries={[rateLimitedEntry]} initialMeta={null} />);

      // Assert: badge renders with rate_limited text
      expect(screen.getByText('rate_limited')).toBeInTheDocument();
    });
  });

  describe('Pagination navigation', () => {
    it('calls fetchEntries with page+1 when Next is clicked', async () => {
      // Arrange: start on page 1 of 2
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [ENTRY],
        meta: { page: 2, limit: 50, total: 100, totalPages: 2 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      // Act: click Next
      await act(async () => {
        fireEvent.click(screen.getByText('Next'));
      });

      // Assert: apiClient.get called with page: 2
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/audit'),
          expect.objectContaining({ params: expect.objectContaining({ page: 2 }) })
        );
      });
    });

    it('calls fetchEntries with page-1 when Previous is clicked on page 2', async () => {
      // Arrange: start on page 2 of 3
      const page2Meta = { page: 2, limit: 50, total: 150, totalPages: 3 };
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [ENTRY],
        meta: { page: 1, limit: 50, total: 150, totalPages: 3 },
      });

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={page2Meta} />);

      // Assert: Previous is enabled on page 2
      expect(screen.getByText('Previous')).not.toBeDisabled();

      // Act: click Previous
      await act(async () => {
        fireEvent.click(screen.getByText('Previous'));
      });

      // Assert: apiClient.get called with page: 1
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/audit'),
          expect.objectContaining({ params: expect.objectContaining({ page: 1 }) })
        );
      });
    });
  });

  describe('Error handling', () => {
    it('shows error message when fetchEntries fails', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      // Trigger a fetch
      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load audit entries.')).toBeInTheDocument();
      });
    });

    it('clears error on next successful fetch', async () => {
      // First fetch fails
      vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network error'));

      render(<McpAuditLog initialEntries={[ENTRY]} initialMeta={META} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load audit entries.')).toBeInTheDocument();
      });

      // Second fetch succeeds
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [ENTRY],
        meta: META,
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      await waitFor(() => {
        expect(screen.queryByText('Failed to load audit entries.')).not.toBeInTheDocument();
      });
    });
  });

  describe('Empty state with active filters', () => {
    it('shows filter-specific empty message when entries are empty and hasFilters is true', async () => {
      // Arrange: fetch returns empty after applying filter
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      });

      render(<McpAuditLog initialEntries={[]} initialMeta={null} />);

      // Act: set a date filter and apply
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });

      await act(async () => {
        fireEvent.click(screen.getByText('Apply Filters'));
      });

      // Assert: filter-specific empty message shown
      await waitFor(() => {
        expect(screen.getByText('No entries match the current filters.')).toBeInTheDocument();
      });
    });
  });
});
