/**
 * DocumentChunksModal Component Tests
 *
 * @see components/admin/orchestration/knowledge/document-chunks-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { DocumentChunksModal } from '@/components/admin/orchestration/knowledge/document-chunks-modal';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockChunks = [
  {
    id: 'chunk-1',
    content: 'First chunk about chain of thought',
    chunkType: 'pattern_overview',
    patternNumber: 1,
    patternName: 'Chain of Thought',
    section: 'Overview',
    category: 'patterns',
    keywords: 'reasoning,logic',
    estimatedTokens: 50,
  },
  {
    id: 'chunk-2',
    content: 'Second chunk with implementation details',
    chunkType: 'pattern_section',
    patternNumber: 1,
    patternName: 'Chain of Thought',
    section: 'Implementation',
    category: 'patterns',
    keywords: null,
    estimatedTokens: 120,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentChunksModal', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { chunks: mockChunks } }),
    });
  });

  it('fetches and displays chunks when opened', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test Document"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/documents/doc-1/chunks'));
    });

    await waitFor(() => {
      expect(screen.getByText('First chunk about chain of thought')).toBeInTheDocument();
      expect(screen.getByText('Second chunk with implementation details')).toBeInTheDocument();
    });
  });

  it('displays document name in title', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="My Knowledge Doc"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    expect(screen.getByText(/My Knowledge Doc — Chunks/)).toBeInTheDocument();
  });

  it('displays chunk metadata badges', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('pattern overview')).toBeInTheDocument();
      expect(screen.getByText('pattern section')).toBeInTheDocument();
      expect(screen.getAllByText('patterns')).toHaveLength(2);
    });
  });

  it('displays token counts', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('~50 tokens')).toBeInTheDocument();
      expect(screen.getByText('~120 tokens')).toBeInTheDocument();
    });
  });

  it('displays keywords as badges', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('reasoning')).toBeInTheDocument();
      expect(screen.getByText('logic')).toBeInTheDocument();
    });
  });

  it('shows loading state', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves

    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    expect(screen.getByText('Loading chunks...')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/failed to load chunks/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when document has no chunks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { chunks: [] } }),
    });

    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/no chunks found/i)).toBeInTheDocument();
    });
  });

  it('does not fetch when closed', () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={false}
        onOpenChange={onOpenChange}
      />
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when documentId is null', () => {
    render(
      <DocumentChunksModal
        documentId={null}
        documentName={null}
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows chunk count in description', async () => {
    render(
      <DocumentChunksModal
        documentId="doc-1"
        documentName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('2 chunks')).toBeInTheDocument();
    });
  });
});
