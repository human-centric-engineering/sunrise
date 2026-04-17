/**
 * ExploreTab Component Tests
 *
 * Test Coverage:
 * - Initial empty/idle state shown before any query
 * - "Type at least 3 characters" hint shown for short queries
 * - Debounced search triggers fetch after sufficient input
 * - "No results found" empty state shown after search with no results
 * - Results list rendered with similarity scores and chunk types
 * - Clear button (X) clears query and resets results
 * - Result click opens chunk detail dialog
 * - Scope included in POST body when provided
 *
 * @see components/admin/orchestration/knowledge/explore-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExploreTab } from '@/components/admin/orchestration/knowledge/explore-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock react-markdown since we don't need real rendering in tests
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<{
    id: string;
    similarity: number;
    documentName: string;
    content: string;
    chunkType: string;
    patternName: string | null;
  }> = {}
) {
  return {
    similarity: overrides.similarity ?? 0.85,
    documentName: overrides.documentName ?? 'Agentic Patterns Guide',
    chunk: {
      id: overrides.id ?? 'chunk-1',
      content: overrides.content ?? 'This is the chunk content about fan-out patterns.',
      chunkType: overrides.chunkType ?? 'pattern',
      patternName: overrides.patternName ?? 'Fan-Out Pattern',
      patternNumber: 3,
      category: 'orchestration',
      section: 'Introduction',
      keywords: 'fan-out, parallel, concurrency',
      estimatedTokens: 120,
      metadata: { source: 'guide' },
    },
  };
}

const SEARCH_RESPONSE = {
  success: true,
  data: {
    results: [
      makeResult({ id: 'chunk-1', similarity: 0.92, documentName: 'Patterns Guide' }),
      makeResult({
        id: 'chunk-2',
        similarity: 0.65,
        documentName: 'Patterns Guide',
        chunkType: 'overview',
      }),
    ],
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExploreTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('shows idle empty state before any query', () => {
    render(<ExploreTab />);

    expect(screen.getByText('Explore the knowledge base')).toBeInTheDocument();
    expect(screen.getByText(/enter a natural language query/i)).toBeInTheDocument();
  });

  it('renders the search input', () => {
    render(<ExploreTab />);

    expect(screen.getByPlaceholderText('Search the knowledge base...')).toBeInTheDocument();
  });

  // ── Short query hint ───────────────────────────────────────────────────────

  it('shows "Type at least 3 characters" hint for 1-2 character input', async () => {
    const user = userEvent.setup();
    render(<ExploreTab />);

    await user.type(screen.getByPlaceholderText('Search the knowledge base...'), 'ab');

    expect(screen.getByText('Type at least 3 characters to search')).toBeInTheDocument();
  });

  // ── Clear button ───────────────────────────────────────────────────────────

  it('shows clear button when query is not empty', async () => {
    const user = userEvent.setup();
    render(<ExploreTab />);

    await user.type(screen.getByPlaceholderText('Search the knowledge base...'), 'ab');

    // X button should appear — it's the only button when no results yet
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking X clears the query', async () => {
    const user = userEvent.setup();
    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    await user.type(input, 'ab');
    expect((input as HTMLInputElement).value).toBe('ab');

    // Click the X button
    const clearBtn = screen.getByRole('button');
    await user.click(clearBtn);

    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Explore the knowledge base')).toBeInTheDocument();
  });

  // ── Debounced search ───────────────────────────────────────────────────────

  it('triggers search via debounce for query of 3+ characters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab />);

    // Use fireEvent to set value directly, bypassing debounce timing issues in tests
    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    // Wait for debounce (400ms) to fire — use waitFor with enough timeout
    await waitFor(
      () => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/search'),
          expect.objectContaining({ method: 'POST' })
        );
      },
      { timeout: 2000 }
    );
  });

  // ── Results list ───────────────────────────────────────────────────────────

  it('renders search results with similarity scores', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    await waitFor(
      () => {
        expect(screen.getByText('92%')).toBeInTheDocument();
        expect(screen.getByText('65%')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it('renders chunk type badges', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    await waitFor(
      () => {
        expect(screen.getByText('pattern')).toBeInTheDocument();
        expect(screen.getByText('overview')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it('shows results count', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    await waitFor(
      () => {
        expect(screen.getByText('2 results')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // ── No results state ───────────────────────────────────────────────────────

  it('shows "No results found" when search returns empty results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { results: [] } }),
    });

    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'xyz-unknown-query' } });

    await waitFor(
      () => {
        expect(screen.getByText('No results found')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // ── Detail dialog ──────────────────────────────────────────────────────────

  it('opens chunk detail dialog when a result is clicked', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    const user = userEvent.setup();
    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    // Wait for results
    await waitFor(() => expect(screen.getByText('92%')).toBeInTheDocument(), { timeout: 2000 });

    // Click first result button (the chunk result card)
    const resultButtons = screen.getAllByRole('button');
    // Find the button that is a result card (contains rounded-lg border class)
    const resultCard = resultButtons.find(
      (btn) =>
        btn.tagName === 'BUTTON' &&
        !btn.hasAttribute('aria-haspopup') &&
        btn.className.includes('rounded-lg')
    );
    if (resultCard) {
      await user.click(resultCard);
    }

    await waitFor(() => expect(screen.getByText('Chunk Detail')).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  // ── Scope ──────────────────────────────────────────────────────────────────

  it('includes scope in POST body when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab scope="system" />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    await waitFor(
      () => {
        const searchCall = mockFetch.mock.calls.find((call) =>
          (call[0] as string).includes('/knowledge/search')
        );
        expect(searchCall).toBeDefined();
        if (!searchCall) return;
        const body = JSON.parse(searchCall[1].body as string) as Record<string, unknown>;
        expect(body.scope).toBe('system');
      },
      { timeout: 2000 }
    );
  });

  // ── No-scope omits scope field ─────────────────────────────────────────────

  it('does not include scope in POST body when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SEARCH_RESPONSE),
    });

    render(<ExploreTab />);

    const input = screen.getByPlaceholderText('Search the knowledge base...');
    fireEvent.change(input, { target: { value: 'fan-out patterns' } });

    await waitFor(
      () => {
        const searchCall = mockFetch.mock.calls.find((call) =>
          (call[0] as string).includes('/knowledge/search')
        );
        expect(searchCall).toBeDefined();
        if (!searchCall) return;
        const body = JSON.parse(searchCall[1].body as string) as Record<string, unknown>;
        expect(body.scope).toBeUndefined();
      },
      { timeout: 2000 }
    );
  });
});
