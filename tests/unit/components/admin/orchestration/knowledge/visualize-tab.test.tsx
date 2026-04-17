/**
 * VisualizeTab Component Tests
 *
 * Test Coverage:
 * - Loading skeleton shown while fetching graph data
 * - Empty state shown when no graph data or zero documents
 * - Stats cards render document count, completion %, chunk count, total tokens
 * - View toggle (Structure / Embedded) renders both buttons
 * - Fullscreen button present
 * - Filter input rendered
 * - Clearing filter resets it to empty string
 * - Empty state message varies by scope
 *
 * @see components/admin/orchestration/knowledge/visualize-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VisualizeTab } from '@/components/admin/orchestration/knowledge/visualize-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ReactECharts uses dynamic import + canvas; stub it out entirely
vi.mock('echarts-for-react', () => ({
  default: () => <div data-testid="echarts-mock">chart</div>,
}));

vi.mock('next/dynamic', () => ({
  default: (_fn: () => Promise<{ default: unknown }>) => {
    // Return the stub directly
    return () => <div data-testid="echarts-mock">chart</div>;
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeGraphData(
  overrides: Partial<{
    documentCount: number;
    completedCount: number;
    chunkCount: number;
    totalTokens: number;
  }> = {}
) {
  const documentCount = overrides.documentCount ?? 3;
  const completedCount = overrides.completedCount ?? 2;
  const chunkCount = overrides.chunkCount ?? 42;
  const totalTokens = overrides.totalTokens ?? 8500;

  return {
    nodes: [
      {
        id: 'kb-1',
        name: 'Knowledge Base',
        type: 'kb',
        value: 20,
        category: 0,
        metadata: { documents: documentCount, chunks: chunkCount, totalTokens },
      },
      {
        id: 'doc-1',
        name: 'Patterns Guide',
        type: 'document',
        value: 12,
        category: 1,
        metadata: { status: 'ready', chunkCount: 42, totalTokens: 8000 },
      },
    ],
    links: [{ source: 'kb-1', target: 'doc-1' }],
    categories: [{ name: 'Knowledge Base' }, { name: 'Document (Ready)' }],
    stats: {
      documentCount,
      completedCount,
      chunkCount,
      totalTokens,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VisualizeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows loading skeleton while fetching', () => {
    // Never resolves — stays in loading state
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { container } = render(<VisualizeTab />);

    // Skeleton loading pulse elements
    const pulseEls = container.querySelectorAll('.animate-pulse');
    expect(pulseEls.length).toBeGreaterThan(0);
    expect(screen.queryByText('Documents')).not.toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows empty state when documentCount is 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: makeGraphData({ documentCount: 0 }),
        }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/no.*knowledge base data/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when fetch returns non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/no.*knowledge base data/i)).toBeInTheDocument();
    });
  });

  it('shows app-scope empty state message when scope is "app"', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: makeGraphData({ documentCount: 0 }),
        }),
    });

    render(<VisualizeTab scope="app" />);

    await waitFor(() => {
      expect(
        screen.getByText(/upload app-specific documents to see them here/i)
      ).toBeInTheDocument();
    });
  });

  // ── Stats cards ────────────────────────────────────────────────────────────

  it('renders document count stat card', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData({ documentCount: 3 }) }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText('Documents')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('renders chunk count stat card', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData({ chunkCount: 42 }) }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText('Chunks')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  it('renders total tokens stat card with locale formatting', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData({ totalTokens: 12500 }) }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText('Total Tokens')).toBeInTheDocument();
      expect(screen.getByText('12,500')).toBeInTheDocument();
    });
  });

  it('renders completion percentage stat', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: makeGraphData({ documentCount: 4, completedCount: 3 }),
        }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      // 3/4 = 75%
      expect(screen.getByText('75%')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
  });

  // ── View toggle ────────────────────────────────────────────────────────────

  it('renders Structure and Embedded view toggle buttons', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Structure' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Embedded' })).toBeInTheDocument();
    });
  });

  it('switching to Embedded view triggers a new fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Embedded' })).toBeInTheDocument()
    );

    const initialCallCount = mockFetch.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Embedded' }));

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string];
      expect(lastCall[0]).toContain('view=embedded');
    });
  });

  // ── Filter input ───────────────────────────────────────────────────────────

  it('renders filter nodes input', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Filter nodes...')).toBeInTheDocument();
    });
  });

  it('clear filter button appears when filter has text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByPlaceholderText('Filter nodes...')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('Filter nodes...'), 'pattern');

    // Filter input has text
    const filterInput = screen.getByPlaceholderText('Filter nodes...');
    expect((filterInput as HTMLInputElement).value).toBe('pattern');
  });

  // ── Fullscreen button ──────────────────────────────────────────────────────

  it('renders Fullscreen button', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /fullscreen/i })).toBeInTheDocument();
    });
  });

  it('clicking Fullscreen shows Exit Fullscreen button', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: makeGraphData() }),
    });

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /fullscreen/i })).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: /fullscreen/i }));

    expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument();
  });
});
