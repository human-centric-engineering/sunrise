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
});
