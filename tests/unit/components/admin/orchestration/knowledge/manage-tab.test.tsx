/**
 * ManageTab Component Tests
 *
 * Test Coverage:
 * - Renders document list with names and status badges
 * - Empty state when no documents
 * - "Load Agentic Design Patterns" seed button calls seed endpoint
 * - Rechunk button calls rechunk endpoint for non-seeded documents
 * - Pre-seeded documents show "Pre-chunked" badge instead of Rechunk button
 * - onRefresh called after seed and rechunk
 * - Embed button is disabled when no chunks or no provider
 * - Seed error message displayed on failure
 *
 * @see components/admin/orchestration/knowledge/manage-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ManageTab } from '@/components/admin/orchestration/knowledge/manage-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDocument(
  overrides: Partial<{
    id: string;
    name: string;
    fileName: string;
    status: string;
    chunkCount: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'doc-1',
    name: overrides.name ?? 'My Document',
    fileName: overrides.fileName ?? 'doc.pdf',
    fileHash: 'abc123',
    chunkCount: overrides.chunkCount ?? 10,
    status: overrides.status ?? 'ready',
    scope: 'app',
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

const SEEDED_DOC = makeDocument({
  id: 'doc-seeded',
  name: 'Agentic Design Patterns',
  fileName: 'agentic-design-patterns.md',
  status: 'ready',
  chunkCount: 42,
});

const USER_DOC = makeDocument({
  id: 'doc-user',
  name: 'My Custom Doc',
  fileName: 'custom.pdf',
  status: 'ready',
  chunkCount: 5,
});

const PENDING_DOC = makeDocument({
  id: 'doc-pending',
  name: 'Processing Doc',
  fileName: 'processing.txt',
  status: 'processing',
  chunkCount: 0,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ManageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all supplementary fetches succeed with no data
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Document list ──────────────────────────────────────────────────────────

  it('renders document names in the table', () => {
    render(<ManageTab documents={[USER_DOC, PENDING_DOC]} onRefresh={vi.fn()} />);

    expect(screen.getByText('My Custom Doc')).toBeInTheDocument();
    expect(screen.getByText('Processing Doc')).toBeInTheDocument();
  });

  it('renders document count in heading', () => {
    render(<ManageTab documents={[USER_DOC, PENDING_DOC]} onRefresh={vi.fn()} />);

    expect(screen.getByText('Documents (2)')).toBeInTheDocument();
  });

  it('shows correct status badges', () => {
    render(<ManageTab documents={[USER_DOC, PENDING_DOC]} onRefresh={vi.fn()} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('shows chunk counts', () => {
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    expect(screen.getByText('5')).toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows empty state when documents array is empty', () => {
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    expect(screen.getByText('No documents yet.')).toBeInTheDocument();
    expect(
      screen.getByText('Upload a file or load the built-in patterns to get started.')
    ).toBeInTheDocument();
  });

  // ── Seeded vs user documents ───────────────────────────────────────────────

  it('shows "Pre-chunked" badge for agentic-design-patterns.md document', () => {
    render(<ManageTab documents={[SEEDED_DOC]} onRefresh={vi.fn()} />);

    expect(screen.getByText('Pre-chunked')).toBeInTheDocument();
    // No Rechunk action button for seeded doc — only the FieldHelp ⓘ button may reference rechunk
    // in its aria-label, but the ghost action button should not be present.
    const rechunkActionButtons = screen.queryAllByRole('button', { name: /^rechunk$/i });
    expect(rechunkActionButtons).toHaveLength(0);
  });

  it('shows Rechunk button for user-uploaded documents', () => {
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    // getAllByRole handles multiple matches (action button + possible FieldHelp button)
    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    // At least one button should be present
    expect(rechunkButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Pre-chunked')).not.toBeInTheDocument();
  });

  // ── Seed button ────────────────────────────────────────────────────────────

  it('renders "Load Agentic Design Patterns" button', () => {
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    expect(
      screen.getByRole('button', { name: /load agentic design patterns/i })
    ).toBeInTheDocument();
  });

  it('calls seed endpoint when seed button is clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<ManageTab documents={[]} onRefresh={onRefresh} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/seed'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('calls onRefresh after successful seed', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<ManageTab documents={[]} onRefresh={onRefresh} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledOnce();
    });
  });

  it('shows seed error message on HTTP error response', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/knowledge/seed')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { message: 'Seed data not found' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    await waitFor(() => {
      expect(screen.getByText('Seed data not found')).toBeInTheDocument();
    });
  });

  it('shows network error message when seed fetch throws', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/knowledge/seed')) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    await waitFor(() => {
      expect(screen.getByText(/network error — could not reach the server/i)).toBeInTheDocument();
    });
  });

  // ── Rechunk ────────────────────────────────────────────────────────────────

  it('calls rechunk endpoint for user document', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<ManageTab documents={[USER_DOC]} onRefresh={onRefresh} />);

    // Use getAllByRole and pick the first ghost button (the action button, not the FieldHelp ⓘ)
    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    // The action button is a ghost variant button (not a FieldHelp popover trigger)
    const actionButton = rechunkButtons.find((btn) => !btn.hasAttribute('aria-haspopup'));
    expect(actionButton).toBeDefined();
    await user.click(actionButton!);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-user/rechunk'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('calls onRefresh after rechunk completes', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<ManageTab documents={[USER_DOC]} onRefresh={onRefresh} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    const actionButton = rechunkButtons.find((btn) => !btn.hasAttribute('aria-haspopup'));
    expect(actionButton).toBeDefined();
    await user.click(actionButton!);

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  // ── Embed button disabled states ───────────────────────────────────────────

  it('Generate Embeddings button is disabled by default (no chunks loaded)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ data: { total: 0, embedded: 0, pending: 0, hasActiveProvider: true } }),
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      // Get the first Generate Embeddings button (the action button, not the FieldHelp trigger)
      const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
      expect(embedButtons[0]).toBeDisabled();
    });
  });

  // ── Compare providers link ─────────────────────────────────────────────────

  it('renders "Compare embedding providers" link', () => {
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    expect(screen.getByText(/compare embedding providers/i)).toBeInTheDocument();
  });
});
