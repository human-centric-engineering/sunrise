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
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ManageTab } from '@/components/admin/orchestration/knowledge/manage-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// DocumentUploadZone uses apiClient.get for tags — mock it to return empty list
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDocument(
  overrides: Partial<{
    id: string;
    name: string;
    fileName: string;
    status: string;
    chunkCount: number;
    tags: Array<{ id: string; slug: string; name: string }>;
  }> = {}
) {
  return {
    id: overrides.id ?? 'doc-1',
    knowledgeBaseId: 'kb_default',
    name: overrides.name ?? 'My Document',
    fileName: overrides.fileName ?? 'doc.pdf',
    fileHash: 'abc123',
    chunkCount: overrides.chunkCount ?? 10,
    status: overrides.status ?? 'ready',
    scope: 'app',
    category: null,
    sourceUrl: null,
    errorMessage: null,
    metadata: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    tags: overrides.tags ?? [],
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
    // The hint copy is split by an inline <strong> ("Upload document"), so we
    // assert on the `<p>` tagName directly to avoid matching ancestor wrappers.
    const hint = screen.getAllByText((_, node) => {
      if (!node) return false;
      return (
        node.tagName === 'P' &&
        node.textContent?.includes(
          'Use the Upload document button above to add your own files, or load the Built-in: Agentic Design Patterns reference from the panel below.'
        ) === true
      );
    });
    expect(hint.length).toBeGreaterThan(0);
  });

  it('shows the Upload document button that opens the upload dialog', () => {
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    expect(screen.getByRole('button', { name: /upload document/i })).toBeInTheDocument();
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
      // test-review:accept no_arg_called — onRefresh is () => void by contract; zero-arg callback, no shape to verify
      expect(onRefresh).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
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

  // ── Embed button ──────────────────────────────────────────────────────────

  it('calls embed endpoint when Generate Embeddings is clicked', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 0, pending: 10, hasActiveProvider: true },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
      expect(embedButtons[0]).not.toBeDisabled();
    });

    const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
    await user.click(embedButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/embed'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('shows embed error message on HTTP error response', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 0, pending: 10, hasActiveProvider: true },
            }),
        });
      }
      if (url.includes('/knowledge/embed')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { message: 'Provider unavailable' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
      expect(embedButtons[0]).not.toBeDisabled();
    });

    const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
    await user.click(embedButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
    });
  });

  it('shows network error when embed fetch throws', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 0, pending: 10, hasActiveProvider: true },
            }),
        });
      }
      if (url.includes('/knowledge/embed')) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
      expect(embedButtons[0]).not.toBeDisabled();
    });

    const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
    await user.click(embedButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/network error — could not reach the server/i)).toBeInTheDocument();
    });
  });

  // ── Embedding status indicators ───────────────────────────────────────────

  it('shows "All chunks embedded" when fully embedded', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 10, pending: 0, hasActiveProvider: true },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    // When setup is complete the built-in panel auto-collapses and moves to
    // the bottom of the page. Expand it before asserting on its body content.
    const panelToggle = await screen.findByRole('button', {
      name: /built-in: agentic design patterns/i,
    });
    await user.click(panelToggle);

    await waitFor(() => {
      expect(screen.getByText('All chunks embedded')).toBeInTheDocument();
    });
  });

  it('shows embedding progress when partially embedded', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 5, pending: 5, hasActiveProvider: true },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText('5/10 embedded')).toBeInTheDocument();
    });
  });

  // ── Last seeded at ────────────────────────────────────────────────────────

  it('shows last seeded timestamp when available', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/settings')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { lastSeededAt: '2025-06-15T10:00:00Z' },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText(/last seeded:/i)).toBeInTheDocument();
    });
  });

  it('renders a tag-count chip in the Tags column when the document has tags', async () => {
    // The column shows a count rather than every tag inline — a doc with many
    // tags would otherwise overflow the row. Clicking the chip opens the
    // chunks modal where the operator edits the actual tag list.
    const docWithTags = makeDocument({
      id: 'doc-tag',
      name: 'Sales Playbook',
      tags: [
        { id: 'tag-cuid-1', slug: 'sales', name: 'Sales' },
        { id: 'tag-cuid-2', slug: 'pricing', name: 'Pricing' },
        { id: 'tag-cuid-3', slug: 'q4', name: 'Q4' },
      ],
    });

    render(<ManageTab documents={[docWithTags]} onRefresh={vi.fn()} />);

    expect(screen.getByText('3 tags')).toBeInTheDocument();
    // Tooltip carries the full list so it stays discoverable from the row.
    expect(screen.getByLabelText(/Edit 3 tags on Sales Playbook/i)).toBeInTheDocument();
  });

  it('uses singular "1 tag" when the document has exactly one tag', async () => {
    const docOneTag = makeDocument({
      id: 'doc-one',
      name: 'Single',
      tags: [{ id: 'tag-cuid-1', slug: 'sales', name: 'Sales' }],
    });

    render(<ManageTab documents={[docOneTag]} onRefresh={vi.fn()} />);

    expect(screen.getByText('1 tag')).toBeInTheDocument();
  });

  it('renders a "+ Add" affordance in the Tags column when a document has no tags', async () => {
    const docWithoutTags = makeDocument({ id: 'doc-empty', name: 'Untagged Doc', tags: [] });

    render(<ManageTab documents={[docWithoutTags]} onRefresh={vi.fn()} />);

    expect(screen.getByText('+ Add')).toBeInTheDocument();
  });

  // ── Delete action ─────────────────────────────────────────────────────────

  it('shows delete confirmation when trash button is clicked', async () => {
    const user = userEvent.setup();
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    // Find the trash button via its SVG icon class
    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) {
      await user.click(deleteBtn);
    }

    await waitFor(() => {
      expect(screen.getByText(/Delete\?/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^no$/i })).toBeInTheDocument();
    });
  });

  it('calls DELETE endpoint when confirmed', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<ManageTab documents={[USER_DOC]} onRefresh={onRefresh} />);

    // Find and click the delete button
    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) {
      await user.click(deleteBtn);
    }

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^yes$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-user'),
        expect.objectContaining({ method: 'DELETE' })
      );
      // test-review:accept no_arg_called — onRefresh is () => void by contract; zero-arg callback, no shape to verify
      expect(onRefresh).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });
  });

  it('cancels delete on "No" click', async () => {
    const user = userEvent.setup();
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) {
      await user.click(deleteBtn);
    }

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^no$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^no$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
    });
  });

  // ── pending_review status ─────────────────────────────────────────────────

  it('shows "Needs Review" badge for pending_review documents', () => {
    const reviewDoc = makeDocument({
      id: 'doc-review',
      name: 'PDF Document',
      status: 'pending_review',
    });
    render(<ManageTab documents={[reviewDoc]} onRefresh={vi.fn()} />);

    expect(screen.getByText('Needs Review')).toBeInTheDocument();
  });

  it('shows Review button instead of Rechunk for pending_review documents', () => {
    const reviewDoc = makeDocument({
      id: 'doc-review',
      name: 'PDF Document',
      status: 'pending_review',
    });
    render(<ManageTab documents={[reviewDoc]} onRefresh={vi.fn()} />);

    expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rechunk/i })).not.toBeInTheDocument();
  });

  // ── Document name click → chunks viewer ───────────────────────────────────

  it('makes document names clickable', () => {
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const nameLink = screen.getByRole('button', { name: 'My Custom Doc' });
    expect(nameLink).toBeInTheDocument();
    expect(nameLink.tagName.toLowerCase()).toBe('button');
  });

  // ── Delete error states ──────────────────────────────────────────────────

  it('shows delete error when DELETE endpoint returns non-ok with message', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: { message: 'Not allowed' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    // Open delete confirm
    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^yes$/i }));

    await waitFor(() => {
      expect(screen.getByText('Not allowed')).toBeInTheDocument();
    });
  });

  it('shows network error when DELETE fetch throws', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^yes$/i }));

    await waitFor(() => {
      expect(screen.getByText(/network error — could not reach the server/i)).toBeInTheDocument();
    });
  });

  // ── Rechunk error states ─────────────────────────────────────────────────

  it('shows rechunk error when rechunk endpoint returns non-ok with message', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url.includes('/rechunk')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: { message: 'Document is processing' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    const actionButton = rechunkButtons.find((btn) => !btn.hasAttribute('aria-haspopup'));
    expect(actionButton).toBeDefined();
    await user.click(actionButton!);

    await waitFor(() => {
      expect(screen.getByText('Document is processing')).toBeInTheDocument();
    });
  });

  it('shows network error when rechunk fetch throws', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url.includes('/rechunk')) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    const actionButton = rechunkButtons.find((btn) => !btn.hasAttribute('aria-haspopup'));
    expect(actionButton).toBeDefined();
    await user.click(actionButton!);

    await waitFor(() => {
      expect(screen.getByText(/network error — could not reach the server/i)).toBeInTheDocument();
    });
  });

  // ── Modal triggers (open the comparison + chunks modals) ──────────────────

  it('opens the embedding-providers comparison modal when its link is clicked', async () => {
    const user = userEvent.setup();
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    // The CompareProvidersModal renders its dialog only after the trigger fires.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /compare embedding providers/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('opens the chunks modal when a document name is clicked', async () => {
    const user = userEvent.setup();
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: USER_DOC.name }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('opens the chunks modal when the Review button on a pending_review document is clicked', async () => {
    const user = userEvent.setup();
    const reviewDoc = makeDocument({
      id: 'doc-review',
      name: 'Pending PDF',
      status: 'pending_review',
      chunkCount: 3,
    });
    render(<ManageTab documents={[reviewDoc]} onRefresh={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /review/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  // ── Upload dialog callbacks ───────────────────────────────────────────────
  // These cover handleUploadComplete and handlePdfPreview, which are called
  // by the DocumentUploadZone inside the upload Dialog.

  it('closes the upload dialog and calls onRefresh when upload completes', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    // Mock: tags fetch (empty) + successful upload response
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/knowledge/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: [] }),
        });
      }
      if (opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: {} }), // no preview — triggers onUploadComplete
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[]} onRefresh={onRefresh} />);

    // Open the upload dialog
    await user.click(screen.getByRole('button', { name: /upload document/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Stage a file via the hidden input
    const input = screen.getByLabelText(/upload documents/i);
    const mdFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [mdFile] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    // Act: submit the upload
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    // Assert: onRefresh was called (handleUploadComplete fired)
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('shows distinctKeywordCount as a number when document has keywords', () => {
    // Covers the `count > 0` branch in the BM25 keywords column
    const docWithKeywords = {
      ...makeDocument({ id: 'doc-kw', name: 'KW Doc' }),
      distinctKeywordCount: 5,
    };

    render(<ManageTab documents={[docWithKeywords]} onRefresh={vi.fn()} />);

    // When count > 0, the button shows the count rather than "Enrich"
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^enrich$/i })).not.toBeInTheDocument();
  });

  it('clicking the tag badge opens the tags modal (fn 23: tag-badge onClick)', async () => {
    // Covers the inline onClick for the tag badge in the Tags column
    const user = userEvent.setup();
    const docWithTags = makeDocument({
      id: 'doc-tag-click',
      name: 'Tagged Doc',
      tags: [{ id: 'tag-1', slug: 'sales', name: 'Sales' }],
    });

    render(<ManageTab documents={[docWithTags]} onRefresh={vi.fn()} />);

    // Click the "1 tag" badge to open the DocumentTagsModal
    await user.click(screen.getByLabelText(/Edit 1 tag on Tagged Doc/i));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('closing the chunks modal via Escape clears viewChunksId (fn 34: onOpenChange)', async () => {
    // Covers the DocumentChunksModal onOpenChange close handler:
    //   (open) => { if (!open) { setViewChunksId(null); setViewChunksName(null); } }
    const user = userEvent.setup();
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    // Open chunks modal
    await user.click(screen.getByRole('button', { name: USER_DOC.name }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Close via Escape
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows seed fallback error when res.json() throws on seed error response (fn 6: () => null)', async () => {
    // Covers the `() => null` catch fallback in handleSeed's error path:
    //   errorBodySchema.safeParse(await res.json().catch(() => null))
    // when res.json() itself throws.
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/knowledge/seed')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('invalid json')), // json() throws
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    // Assert: fallback error message using the status code
    await waitFor(() => {
      expect(screen.getByText(/Load failed \(500\)/i)).toBeInTheDocument();
    });
  });

  it('shows embed fallback error when res.json() throws on embed error response (fn 8: () => null)', async () => {
    // Covers the `() => null` catch fallback in handleEmbed's error path.
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embedding-status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { total: 10, embedded: 0, pending: 10, hasActiveProvider: true },
            }),
        });
      }
      if (url.includes('/knowledge/embed')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.reject(new Error('invalid json')),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
      expect(embedButtons[0]).not.toBeDisabled();
    });

    const embedButtons = screen.getAllByRole('button', { name: /generate embeddings/i });
    await user.click(embedButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/Embedding failed \(503\)/i)).toBeInTheDocument();
    });
  });

  it('shows rechunk fallback error when res.json() throws on rechunk error (fn 10: () => null)', async () => {
    // Covers the `() => null` catch fallback in handleRechunk's error path.
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url.includes('/rechunk')) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.reject(new Error('invalid json')),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    const actionButton = rechunkButtons.find((btn) => !btn.hasAttribute('aria-haspopup'));
    expect(actionButton).toBeDefined();
    await user.click(actionButton!);

    await waitFor(() => {
      expect(screen.getByText(/Rechunk failed \(422\)/i)).toBeInTheDocument();
    });
  });

  it('shows delete fallback error when res.json() throws on delete error (fn 12: () => null)', async () => {
    // Covers the `() => null` catch fallback in handleDelete's error path.
    const user = userEvent.setup();
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.reject(new Error('invalid json')),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    const allButtons = screen.getAllByRole('button');
    const deleteBtn = allButtons.find(
      (btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('[class*="trash"]')
    );
    if (deleteBtn) await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^yes$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^yes$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Delete failed \(409\)/i)).toBeInTheDocument();
    });
  });

  // ── Document Keywords Modal close handler ────────────────────────────────
  // Covers the `onOpenChange` close callback in the DocumentKeywordsModal:
  //   if (!open) { setViewKeywordsId(null); setViewKeywordsName(null); }

  it('closes the keywords modal when its onOpenChange is called with false', async () => {
    const user = userEvent.setup();
    render(<ManageTab documents={[USER_DOC]} onRefresh={vi.fn()} />);

    // Open the keywords modal by clicking the "Enrich" button in the keywords column
    const enrichBtn = screen.getByRole('button', { name: /enrich/i });
    await user.click(enrichBtn);

    // A dialog should now be open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Close by pressing Escape (which triggers onOpenChange(false))
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── Tags Modal open/close ────────────────────────────────────────────────
  // Covers the `onOpenChange` close callback in the DocumentTagsModal:
  //   if (!open) { setEditTagsId(null); setEditTagsName(null); }

  it('opens and closes the tags modal via the + Add button', async () => {
    const user = userEvent.setup();
    const docWithoutTags = makeDocument({ id: 'doc-notags', name: 'Tag-free', tags: [] });
    render(<ManageTab documents={[docWithoutTags]} onRefresh={vi.fn()} />);

    // Click "+ Add" in the Tags column
    await user.click(screen.getByText('+ Add'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Close by pressing Escape
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── Coverage column ───────────────────────────────────────────────────────

  describe('Coverage column', () => {
    it('no coverage for document with null metadata', () => {
      const docNoCoverage = makeDocument({ id: 'doc-no-cov', name: 'No Coverage Doc' });
      // metadata: null by default from makeDocument
      render(<ManageTab documents={[docNoCoverage]} onRefresh={vi.fn()} />);

      // readCoverage(null) returns null — no percentage text should appear
      expect(document.body.textContent).not.toMatch(/\d+%/);
    });

    it('shows green coverage for healthy document (≥95%)', () => {
      const docHealthy = {
        ...makeDocument({ id: 'doc-healthy', name: 'Healthy Doc' }),
        metadata: { coverage: { parsedChars: 1000, chunkChars: 990, coveragePct: 99 } },
      };
      render(<ManageTab documents={[docHealthy]} onRefresh={vi.fn()} />);

      expect(screen.getByText('99%')).toBeInTheDocument();
    });

    it('shows amber-class coverage for low-coverage document (<95%)', () => {
      const docLow = {
        ...makeDocument({ id: 'doc-low', name: 'Low Coverage Doc' }),
        metadata: { coverage: { parsedChars: 1000, chunkChars: 700, coveragePct: 70 } },
      };
      render(<ManageTab documents={[docLow]} onRefresh={vi.fn()} />);

      expect(screen.getByText('70%')).toBeInTheDocument();
    });
  });
});
