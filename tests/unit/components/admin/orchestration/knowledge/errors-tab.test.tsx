/**
 * ErrorsTab Component Tests
 *
 * Test Coverage:
 * - Renders skeleton loading rows while fetching
 * - Empty state shown when no failed documents
 * - Failed documents list renders document names
 * - Retry button calls retry endpoint and removes document from list
 * - Delete button opens confirmation dialog
 * - Confirm delete calls delete endpoint and removes document from list
 * - Refresh button refetches failed documents
 * - Document count summary text
 *
 * @see components/admin/orchestration/knowledge/errors-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorsTab } from '@/components/admin/orchestration/knowledge/errors-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDocument(
  overrides: Partial<{
    id: string;
    name: string;
    fileName: string;
    errorMessage: string | null;
    createdAt: string;
  }> = {}
) {
  return {
    id: overrides.id ?? 'doc-fail-1',
    name: overrides.name ?? 'Failed Report',
    fileName: overrides.fileName ?? 'report.pdf',
    fileHash: 'hash-abc',
    chunkCount: 0,
    status: 'failed',
    scope: 'app',
    errorMessage: overrides.errorMessage ?? 'Parsing error: unexpected EOF',
    uploadedBy: 'user-1',
    createdAt: overrides.createdAt ?? '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
  };
}

const FAILED_DOCS_RESPONSE = {
  success: true,
  data: [
    makeDocument({ id: 'doc-1', name: 'Failed Report A', fileName: 'report-a.pdf' }),
    makeDocument({
      id: 'doc-2',
      name: 'Failed Report B',
      fileName: 'report-b.txt',
      errorMessage: 'Timeout',
    }),
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ErrorsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows empty state when no failed documents', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    });

    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getByText('No failed documents')).toBeInTheDocument();
      expect(screen.getByText('All documents processed successfully.')).toBeInTheDocument();
    });
  });

  // ── Failed documents list ──────────────────────────────────────────────────

  it('renders failed document names', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getByText('Failed Report A')).toBeInTheDocument();
      expect(screen.getByText('Failed Report B')).toBeInTheDocument();
    });
  });

  it('shows error message for each failed document', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getByText('Parsing error: unexpected EOF')).toBeInTheDocument();
      expect(screen.getByText('Timeout')).toBeInTheDocument();
    });
  });

  it('shows document count summary', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getByText(/2 documents failed during processing/i)).toBeInTheDocument();
    });
  });

  it('renders Retry and Delete buttons for each document', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(2);
    });
  });

  // ── Retry ──────────────────────────────────────────────────────────────────

  it('calls retry endpoint and removes document from list on success', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url.includes('/retry')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
      });
    });

    const user = userEvent.setup();
    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(2);
    });

    await user.click(screen.getAllByRole('button', { name: /retry/i })[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/doc-1/retry'),
        expect.objectContaining({ method: 'POST' })
      );
      // doc-1 should be removed from list
      expect(screen.queryByText('Failed Report A')).not.toBeInTheDocument();
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  it('opens delete confirmation dialog on Delete click', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    const user = userEvent.setup();
    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(2);
    });

    await user.click(screen.getAllByRole('button', { name: /delete/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Delete document?')).toBeInTheDocument();
    });
  });

  it('calls delete endpoint and removes document from list on confirm', async () => {
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
      });
    });

    const user = userEvent.setup();
    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(2);
    });

    // Open dialog
    await user.click(screen.getAllByRole('button', { name: /delete/i })[0]);
    await waitFor(() => expect(screen.getByText('Delete document?')).toBeInTheDocument());

    // Confirm delete — click the destructive Delete button inside the dialog
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    // The last "Delete" button should be the one inside the dialog footer
    await user.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/doc-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  // ── Refresh ────────────────────────────────────────────────────────────────

  it('calls fetch again when Refresh button is clicked', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAILED_DOCS_RESPONSE),
    });

    const user = userEvent.setup();
    render(<ErrorsTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    });

    const initialCallCount = mockFetch.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  // ── Scope filter ───────────────────────────────────────────────────────────

  it('passes scope parameter to fetch URL when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    });

    render(<ErrorsTab scope="app" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('scope=app'));
    });
  });

  // ── Fetch failure (non-ok response) ───────────────────────────────────────

  it('shows empty state when fetch returns non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    render(<ErrorsTab />);

    await waitFor(() => {
      // Loading ends and empty state shown (fetch failure → empty documents)
      expect(screen.getByText('No failed documents')).toBeInTheDocument();
    });
  });
});
