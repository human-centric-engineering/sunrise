/**
 * DocumentKeywordsModal — list distinct BM25 keywords + Enrich action.
 *
 * Aggregation runs client-side over the chunks endpoint's response, so the
 * tests stub `fetch`. Covers:
 *   - Aggregates keywords across chunks; same keyword in two chunks counts twice.
 *   - Same keyword repeated within one chunk counts once (BM25 keys off chunks).
 *   - Empty-state copy renders when no keywords are indexed yet.
 *   - Filter narrows the list.
 *   - Enrich requires confirm; success refreshes the count.
 *   - 503 (no default model) surfaces inline.
 *
 * @see components/admin/orchestration/knowledge/document-keywords-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentKeywordsModal } from '@/components/admin/orchestration/knowledge/document-keywords-modal';

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function chunksResponse(chunks: Array<{ id: string; keywords: string | null }>): {
  ok: true;
  json: () => Promise<unknown>;
} {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data: { chunks } }),
  };
}

function enrichResponse(
  ok: boolean,
  body: unknown
): { ok: boolean; status?: number; json: () => Promise<unknown> } {
  return {
    ok,
    ...(ok ? {} : { status: 503 }),
    json: () => Promise.resolve(body),
  };
}

const baseProps = {
  documentId: 'doc-1',
  documentName: 'Hybrid search guide',
  open: true,
  onOpenChange: vi.fn(),
};

describe('DocumentKeywordsModal', () => {
  it('aggregates distinct keywords with per-chunk counts', async () => {
    mockFetch.mockResolvedValueOnce(
      chunksResponse([
        { id: 'c1', keywords: 'vector-search, bm25, hybrid' },
        { id: 'c2', keywords: 'bm25, reranking' },
        { id: 'c3', keywords: null },
      ])
    );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });
    expect(screen.getByText('bm25')).toBeInTheDocument();
    expect(screen.getByText('hybrid')).toBeInTheDocument();
    expect(screen.getByText('reranking')).toBeInTheDocument();
    // bm25 sits in two chunks, others in one.
    expect(screen.getByText('4 of 4 keywords')).toBeInTheDocument();
  });

  it('counts a duplicated keyword inside the same chunk only once', async () => {
    mockFetch.mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: 'bm25, bm25, hybrid' }]));

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('bm25')).toBeInTheDocument();
    });
    // Only 2 distinct keywords, both in one chunk.
    expect(screen.getByText('2 of 2 keywords')).toBeInTheDocument();
  });

  it('renders an empty state when no chunk has keywords', async () => {
    mockFetch.mockResolvedValueOnce(
      chunksResponse([
        { id: 'c1', keywords: null },
        { id: 'c2', keywords: '   ' },
      ])
    );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });
  });

  it('filters keywords by substring', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      chunksResponse([{ id: 'c1', keywords: 'vector-search, bm25, hybrid' }])
    );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Filter keywords'), 'vec');

    expect(screen.getByText('vector-search')).toBeInTheDocument();
    expect(screen.queryByText('bm25')).not.toBeInTheDocument();
    expect(screen.queryByText('hybrid')).not.toBeInTheDocument();
  });

  it('runs Enrich after confirm and re-fetches the keyword list', async () => {
    const user = userEvent.setup();
    const onEnriched = vi.fn();

    mockFetch
      .mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: null }])) // initial load
      .mockResolvedValueOnce(
        enrichResponse(true, {
          success: true,
          data: { chunksProcessed: 4, chunksFailed: 0, costUsd: 0.0012, model: 'gpt-4o-mini' },
        })
      )
      .mockResolvedValueOnce(
        chunksResponse([{ id: 'c1', keywords: 'vector-search, bm25' }]) // post-enrich refetch
      );

    render(<DocumentKeywordsModal {...baseProps} onEnriched={onEnriched} />);

    await waitFor(() => {
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });

    // First click: opens confirm step (no POST yet).
    await user.click(screen.getByRole('button', { name: /enrich keywords/i }));
    expect(screen.getByText(/overwrite keywords on every chunk/i)).toBeInTheDocument();

    // Second click: POSTs enrich-keywords.
    await user.click(screen.getByRole('button', { name: /yes, overwrite/i }));

    await waitFor(() => {
      expect(screen.getByText(/Enriched 4 chunks/i)).toBeInTheDocument();
    });
    expect(onEnriched).toHaveBeenCalledTimes(1);

    // The re-fetched list shows the new keywords.
    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });
  });

  it('surfaces 503 (no default chat model) inline without re-fetching', async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: null }]))
      .mockResolvedValueOnce(
        enrichResponse(false, {
          success: false,
          error: { message: 'No default chat model is configured.' },
        })
      );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /enrich keywords/i }));
    await user.click(screen.getByRole('button', { name: /yes, overwrite/i }));

    await waitFor(() => {
      expect(screen.getByText(/No default chat model is configured\./)).toBeInTheDocument();
    });
    // Only the initial chunks fetch + the failed enrich attempt — no refetch.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clicking Close calls onOpenChange(false)', async () => {
    // Arrange: modal with keywords loaded
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockFetch.mockResolvedValueOnce(
      chunksResponse([{ id: 'c1', keywords: 'vector-search, bm25' }])
    );

    render(<DocumentKeywordsModal {...baseProps} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });

    // Act: click the "Close" ghost button in the footer (not the dialog X)
    // Use getAllByRole and find the one whose text is exactly "Close"
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    const footerClose = closeButtons.find((btn) => btn.textContent?.trim() === 'Close');
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);

    // Assert: onOpenChange called with false
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clicking Cancel during confirm step returns to the main footer without POSTing', async () => {
    // Arrange
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: null }]));

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });

    // Open confirm step
    await user.click(screen.getByRole('button', { name: /enrich keywords/i }));
    expect(screen.getByRole('button', { name: /yes, overwrite/i })).toBeInTheDocument();

    // Act: click Cancel — should go back to the normal footer
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    // Assert: confirm step gone, main Close + Enrich buttons back
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /yes, overwrite/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /enrich keywords/i })).toBeInTheDocument();
    });
    // No POST was made
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the initial chunks fetch
  });

  it('shows "Re-enrich keywords" when the document already has keywords', async () => {
    // Arrange: document with keywords already indexed
    mockFetch.mockResolvedValueOnce(
      chunksResponse([{ id: 'c1', keywords: 'vector-search, bm25' }])
    );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });

    // Assert: button text changes to "Re-enrich keywords" when rows exist
    expect(screen.getByRole('button', { name: /re-enrich keywords/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^enrich keywords$/i })).not.toBeInTheDocument();
  });

  it('state is reset when modal closes (open transitions to false)', async () => {
    // Arrange: mock the initial chunks fetch before rendering
    mockFetch.mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: 'rag' }]));

    const { rerender } = render(<DocumentKeywordsModal {...baseProps} />);

    // Wait for keywords to load
    await waitFor(() => {
      expect(screen.getByText('rag')).toBeInTheDocument();
    });

    // Act: close the modal by re-rendering with open=false
    rerender(<DocumentKeywordsModal {...baseProps} open={false} />);

    // When re-opened, rows are cleared and a fresh fetch is triggered
    mockFetch.mockResolvedValueOnce(chunksResponse([{ id: 'c2', keywords: null }]));
    rerender(<DocumentKeywordsModal {...baseProps} open={true} />);

    await waitFor(() => {
      // After re-open with empty keywords, shows empty state
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });
  });

  it('shows enrichment network error when fetch throws', async () => {
    // Arrange: enrich call rejects with a network error
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce(chunksResponse([{ id: 'c1', keywords: null }]))
      .mockRejectedValueOnce(new Error('Network failure'));

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('No keywords indexed yet.')).toBeInTheDocument();
    });

    // Trigger enrich (confirm → overwrite)
    await user.click(screen.getByRole('button', { name: /enrich keywords/i }));
    await user.click(screen.getByRole('button', { name: /yes, overwrite/i }));

    // Assert: network error surfaces in the enrichError paragraph
    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeInTheDocument();
    });
  });

  it('shows generic error message when fetch throws a non-Error value', async () => {
    // Arrange: fetch rejects with a non-Error object — covers the
    // `err instanceof Error ? err.message : 'Failed to load keywords'` false branch.
    mockFetch.mockRejectedValueOnce('string rejection — not an Error');

    render(<DocumentKeywordsModal {...baseProps} />);

    // Assert: generic fallback message shown
    await waitFor(() => {
      expect(screen.getByText('Failed to load keywords')).toBeInTheDocument();
    });
  });

  it('shows "No keywords match" when filter has no results', async () => {
    // Arrange: load some keywords then filter to a non-matching term
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      chunksResponse([{ id: 'c1', keywords: 'vector-search, bm25' }])
    );

    render(<DocumentKeywordsModal {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('vector-search')).toBeInTheDocument();
    });

    // Act: type a filter that matches nothing
    await user.type(screen.getByLabelText('Filter keywords'), 'xyz-no-match');

    // Assert: the "no match" empty state shows within the list area
    await waitFor(() => {
      expect(screen.getByText(/No keywords match/i)).toBeInTheDocument();
    });
  });
});
