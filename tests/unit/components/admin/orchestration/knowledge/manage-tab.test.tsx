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
    category: null,
    sourceUrl: null,
    errorMessage: null,
    metadata: null,
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

  // ── Meta-tags panel ───────────────────────────────────────────────────────

  it('renders separate app and system meta-tag sections', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: {
                  categories: [
                    { value: 'sales', chunkCount: 15, documentCount: 3 },
                    { value: 'engineering', chunkCount: 8, documentCount: 2 },
                  ],
                  keywords: [{ value: 'pricing', chunkCount: 5, documentCount: 1 }],
                },
                system: {
                  categories: [{ value: 'patterns', chunkCount: 20, documentCount: 1 }],
                  keywords: [],
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Meta-tags in use')).toBeInTheDocument();
    });

    // App section is expanded by default
    expect(screen.getByText('App knowledge')).toBeInTheDocument();
    expect(screen.getByText('sales')).toBeInTheDocument();
    expect(screen.getByText('engineering')).toBeInTheDocument();
    expect(screen.getByText('pricing')).toBeInTheDocument();

    // System section present but collapsed by default
    expect(screen.getByText('System knowledge')).toBeInTheDocument();
    // System categories not visible until expanded
    expect(screen.queryByText('patterns')).not.toBeInTheDocument();
  });

  it('expands system section when clicked', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: { categories: [], keywords: [] },
                system: {
                  categories: [{ value: 'patterns', chunkCount: 20, documentCount: 1 }],
                  keywords: [{ value: 'reasoning', chunkCount: 5, documentCount: 1 }],
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText('System knowledge')).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText('System knowledge'));

    await waitFor(() => {
      expect(screen.getByText('patterns')).toBeInTheDocument();
      expect(screen.getByText('reasoning')).toBeInTheDocument();
    });
  });

  it('does not render meta-tags panel when no tags exist in either scope', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: { categories: [], keywords: [] },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/meta-tags'));
    });

    expect(screen.queryByText('Meta-tags in use')).not.toBeInTheDocument();
  });

  it('shows "Show all" toggle and reveals hidden keywords when clicked', async () => {
    const user = userEvent.setup();
    const manyKeywords = Array.from({ length: 35 }, (_, i) => ({
      value: `kw-${i}`,
      chunkCount: i + 1,
      documentCount: 1,
    }));

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: { categories: [], keywords: manyKeywords },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      render(<ManageTab documents={[]} onRefresh={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Meta-tags in use')).toBeInTheDocument();
    });

    // First 30 visible, 31st hidden
    expect(screen.getByText('kw-0')).toBeInTheDocument();
    expect(screen.getByText('kw-29')).toBeInTheDocument();
    expect(screen.queryByText('kw-30')).not.toBeInTheDocument();

    // Click "Show all"
    await user.click(screen.getByText('Show all 35 keywords'));

    // Now all visible
    expect(screen.getByText('kw-30')).toBeInTheDocument();
    expect(screen.getByText('kw-34')).toBeInTheDocument();

    // Toggle back
    await user.click(screen.getByText('Show less'));
    expect(screen.queryByText('kw-30')).not.toBeInTheDocument();
  });

  it('renders category column in document table', async () => {
    const docWithCategory = makeDocument({
      id: 'doc-cat',
      name: 'Sales Playbook',
    });
    (docWithCategory as Record<string, unknown>).category = 'sales';

    render(<ManageTab documents={[docWithCategory]} onRefresh={vi.fn()} />);

    expect(screen.getByText('sales')).toBeInTheDocument();
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
      expect(screen.getByText('Delete?')).toBeInTheDocument();
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
      expect(onRefresh).toHaveBeenCalled();
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
});
