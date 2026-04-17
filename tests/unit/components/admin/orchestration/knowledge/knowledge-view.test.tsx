/**
 * KnowledgeView Component Tests
 *
 * @see components/admin/orchestration/knowledge/knowledge-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeView } from '@/components/admin/orchestration/knowledge/knowledge-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRefresh,
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/knowledge'),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ track: vi.fn() })),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_DOCUMENTS = [
  {
    id: 'doc-1',
    name: 'Agentic Patterns',
    fileName: 'patterns.md',
    fileHash: 'abc',
    chunkCount: 42,
    status: 'ready',
    scope: 'system',
    category: null,
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
  {
    id: 'doc-2',
    name: 'Pending Doc',
    fileName: 'pending.txt',
    fileHash: 'def',
    chunkCount: 0,
    status: 'processing',
    scope: 'app',
    category: null,
    errorMessage: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2025-01-02'),
    updatedAt: new Date('2025-01-02'),
  },
];

const EMBEDDING_STATUS_PARTIAL = {
  total: 10,
  embedded: 5,
  pending: 5,
  hasActiveProvider: true,
};

const EMBEDDING_STATUS_ALL_EMBEDDED = {
  total: 10,
  embedded: 10,
  pending: 0,
  hasActiveProvider: true,
};

const EMBEDDING_STATUS_NO_PROVIDER = {
  total: 5,
  embedded: 0,
  pending: 5,
  hasActiveProvider: false,
};

const EMBEDDING_STATUS_NO_CHUNKS = {
  total: 0,
  embedded: 0,
  pending: 0,
  hasActiveProvider: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  it('renders document table with names', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('Agentic Patterns')).toBeInTheDocument();
    expect(screen.getByText('Pending Doc')).toBeInTheDocument();
  });

  it('shows correct status badges', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('shows chunk counts', () => {
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders empty state when no documents', () => {
    render(<KnowledgeView documents={[]} />);

    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
  });

  it('seed button calls seed endpoint', async () => {
    const user = userEvent.setup();
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/seed'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('rechunk button calls rechunk endpoint', async () => {
    const user = userEvent.setup();
    render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

    const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
    await user.click(rechunkButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-1/rechunk'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ─── handleSeed error paths ─────────────────────────────────────────────────

  describe('handleSeed', () => {
    it('HTTP error with parseable error.message body: shows that message', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/knowledge/seed')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { message: 'Seed source missing' } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

      await waitFor(() => {
        expect(screen.getByText('Seed source missing')).toBeInTheDocument();
      });
    });

    it('HTTP error with unparseable body: shows "Load failed (status)" fallback', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/knowledge/seed')) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.reject(new Error('not json')),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

      await waitFor(() => {
        expect(screen.getByText('Load failed (503)')).toBeInTheDocument();
      });
    });

    it('network throw: shows "Network error" fallback', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/knowledge/seed')) {
          return Promise.reject(new Error('offline'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await user.click(screen.getByRole('button', { name: /load agentic design patterns/i }));

      await waitFor(() => {
        expect(screen.getByText(/network error — could not reach the server/i)).toBeInTheDocument();
      });
    });
  });

  // ─── handleEmbed ────────────────────────────────────────────────────────────

  /** Returns the Generate Embeddings action button (not the FieldHelp ⓘ button). */
  function getEmbedButton() {
    const buttons = screen.getAllByRole('button', { name: /generate embeddings/i });
    // The first match is the action button; the second is the FieldHelp popover trigger
    return buttons[0];
  }

  describe('handleEmbed', () => {
    it('success path: calls embed endpoint then refetches embedding status', async () => {
      const user = userEvent.setup();
      let embedStatusCallCount = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          embedStatusCallCount++;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_PARTIAL }),
          });
        }
        if (url.includes('/embed')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      // Wait for initial status fetch to enable button
      await waitFor(() => {
        expect(embedStatusCallCount).toBeGreaterThanOrEqual(1);
      });

      await user.click(getEmbedButton());

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/embed'),
          expect.objectContaining({ method: 'POST' })
        );
        // Status should be refetched after successful embed
        expect(embedStatusCallCount).toBeGreaterThanOrEqual(2);
      });
    });

    it('HTTP error with parseable error.message body: shows that message', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_PARTIAL }),
          });
        }
        if (url.includes('/embed')) {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: () => Promise.resolve({ error: { message: 'Provider quota exceeded' } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        expect(getEmbedButton()).not.toBeDisabled();
      });

      await user.click(getEmbedButton());

      await waitFor(() => {
        expect(screen.getByText('Provider quota exceeded')).toBeInTheDocument();
      });
    });

    it('HTTP error with unparseable body: shows fallback message with status code', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_PARTIAL }),
          });
        }
        if (url.includes('/embed')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.reject(new Error('not json')),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        expect(getEmbedButton()).not.toBeDisabled();
      });

      await user.click(getEmbedButton());

      await waitFor(() => {
        expect(screen.getByText('Embedding failed (500)')).toBeInTheDocument();
      });
    });

    it('network throw: shows network error message', async () => {
      const user = userEvent.setup();

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_PARTIAL }),
          });
        }
        if (url.includes('/embed')) {
          return Promise.reject(new Error('Network failure'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        expect(getEmbedButton()).not.toBeDisabled();
      });

      await user.click(getEmbedButton());

      await waitFor(() => {
        expect(screen.getByText('Network error — could not reach the server.')).toBeInTheDocument();
      });
    });
  });

  // ─── handleRechunk ──────────────────────────────────────────────────────────

  describe('handleRechunk', () => {
    it('calls rechunk endpoint with POST, calls router.refresh, and clears rechunkingId', async () => {
      const user = userEvent.setup();

      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      const rechunkButtons = screen.getAllByRole('button', { name: /rechunk/i });
      await user.click(rechunkButtons[0]);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/documents/doc-1/rechunk'),
          expect.objectContaining({ method: 'POST' })
        );
        expect(mockRefresh).toHaveBeenCalled();
      });

      // Button should be re-enabled after completion (rechunkingId cleared)
      await waitFor(() => {
        expect(rechunkButtons[0]).not.toBeDisabled();
      });
    });
  });

  // ─── fetchEmbeddingStatus error branch ──────────────────────────────────────

  describe('fetchEmbeddingStatus', () => {
    it('network error during status fetch: component still renders without crashing', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await act(async () => {
        render(<KnowledgeView documents={MOCK_DOCUMENTS} />);
      });

      // Component renders fine; no status badge shown
      expect(screen.getByText('Agentic Patterns')).toBeInTheDocument();
      expect(screen.queryByText(/embedded/i)).not.toBeInTheDocument();
    });
  });

  // ─── Embed button disabled-state matrix ─────────────────────────────────────

  describe('Embed button disabled states', () => {
    it('no chunks (total=0): button is disabled with no-chunks tooltip', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_NO_CHUNKS }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        const btn = getEmbedButton();
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('title', 'Load Agentic Design Patterns first');
      });
    });

    it('no active provider: button is disabled with no-provider tooltip', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_NO_PROVIDER }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        const btn = getEmbedButton();
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('title', 'Configure an embedding provider first');
      });
    });

    it('all chunks embedded: button shows already-embedded tooltip and "All chunks embedded" label', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_ALL_EMBEDDED }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        const btn = getEmbedButton();
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('title', 'All chunks are already embedded');
        expect(screen.getByText('All chunks embedded')).toBeInTheDocument();
      });
    });
  });

  // ─── EmbeddingStatusBanner ──────────────────────────────────────────────────

  describe('EmbeddingStatusBanner', () => {
    it('renders when partial embed progress exists (embedded > 0 and not all embedded)', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_PARTIAL }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      // Partial count label rendered by the inline span
      await waitFor(() => {
        expect(screen.getByText('5/10 embedded')).toBeInTheDocument();
      });
    });

    it('does not render when no embeddings exist yet', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('embedding-status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: EMBEDDING_STATUS_NO_PROVIDER }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      render(<KnowledgeView documents={MOCK_DOCUMENTS} />);

      await waitFor(() => {
        expect(screen.queryByText(/\/\d+ embedded/)).not.toBeInTheDocument();
      });
    });
  });
});
