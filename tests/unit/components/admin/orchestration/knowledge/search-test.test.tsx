/**
 * SearchTest Component Tests
 *
 * @see components/admin/orchestration/knowledge/search-test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SearchTest } from '@/components/admin/orchestration/knowledge/search-test';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SearchTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search input and button', () => {
    render(<SearchTest />);

    expect(screen.getByPlaceholderText(/test a search query/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });

  it('disables search button when query is empty', () => {
    render(<SearchTest />);

    expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
  });

  it('submits query and displays results', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              chunk: {
                id: 'c1',
                content: 'Chain of Thought is a reasoning pattern',
                chunkType: 'pattern_overview',
                chunkKey: 'k1',
                documentId: 'd1',
                patternNumber: 1,
                patternName: 'CoT',
                category: null,
                section: null,
                keywords: null,
                estimatedTokens: 10,
                metadata: null,
              },
              similarity: 0.92,
            },
          ],
        }),
    });

    render(<SearchTest />);

    const input = screen.getByPlaceholderText(/test a search query/i);
    await user.type(input, 'chain of thought');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/chain of thought is a reasoning pattern/i)).toBeInTheDocument();
      expect(screen.getByText(/92\.0%/)).toBeInTheDocument();
    });
  });

  it('shows no results message', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    render(<SearchTest />);

    const input = screen.getByPlaceholderText(/test a search query/i);
    await user.type(input, 'nonexistent');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/no results found/i)).toBeInTheDocument();
    });
  });

  it('shows error on fetch failure', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ ok: false });

    render(<SearchTest />);

    const input = screen.getByPlaceholderText(/test a search query/i);
    await user.type(input, 'test');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/search failed/i)).toBeInTheDocument();
    });
  });
});
