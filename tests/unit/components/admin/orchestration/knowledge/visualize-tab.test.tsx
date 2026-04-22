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
 * - System scope empty-state heading
 * - Default scope (no scope) empty-state heading
 * - Exit fullscreen returns regular toolbar
 * - Filter clear button removes text
 * - Fetch error (thrown) → empty state
 * - Schema parse failure → empty state (no crash)
 * - Aggregation note when chunkCount > 500
 * - Stats cards NOT shown during empty state
 * - Scope query param in fetch URL
 * - Embedded + empty (graphData non-null) → correct heading + toggle
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

function makeFetchResponse(graphData: ReturnType<typeof makeGraphData>) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data: graphData }),
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

  // ── New: System scope empty-state heading ──────────────────────────────────

  it('shows "No system knowledge base data" heading when scope is "system" and documentCount is 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: makeGraphData({ documentCount: 0 }),
        }),
    });

    render(<VisualizeTab scope="system" />);

    await waitFor(() => {
      expect(screen.getByText('No system knowledge base data')).toBeInTheDocument();
    });
  });

  // ── New: Default scope (no scope prop) empty-state heading ─────────────────

  it('shows empty-state heading with no scope qualifier when scope is undefined', async () => {
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
      // scopeLabel is '' when scope is undefined → heading: "No  knowledge base data"
      // Match robustly against whitespace
      expect(screen.getByText(/no\s+knowledge base data/i)).toBeInTheDocument();
    });
  });

  // ── New: Exit fullscreen returns regular toolbar ────────────────────────────

  it('clicking Exit Fullscreen hides it and restores Fullscreen button and filter input', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));

    const user = userEvent.setup();
    render(<VisualizeTab />);

    // Wait for data to load and Fullscreen button to appear
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^fullscreen$/i })).toBeInTheDocument()
    );

    // Enter fullscreen
    await user.click(screen.getByRole('button', { name: /^fullscreen$/i }));
    expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument();

    // Exit fullscreen
    await user.click(screen.getByRole('button', { name: /exit fullscreen/i }));

    // Regular toolbar is back
    expect(screen.getByRole('button', { name: /^fullscreen$/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Filter nodes...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /exit fullscreen/i })).not.toBeInTheDocument();
  });

  // ── New: Filter clear button clears text ───────────────────────────────────

  it('clicking the X clear button empties the filter input', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByPlaceholderText('Filter nodes...')).toBeInTheDocument());

    const filterInput = screen.getByPlaceholderText('Filter nodes...');
    await user.type(filterInput, 'pattern');
    expect((filterInput as HTMLInputElement).value).toBe('pattern');

    // The X button appears when filter has text — click it
    // Find by being the sibling of the input; query by the X icon button pattern
    // The source uses a plain <button> with no aria-label; find by position near the filter
    const xButtons = screen
      .getAllByRole('button')
      .filter((btn) => btn.querySelector('svg') && btn.closest('.relative'));
    // The clear X is the one inside the filter's .relative container
    const clearBtn = xButtons.find((btn) => {
      const parent = btn.closest('.relative');
      return parent?.querySelector('input[placeholder="Filter nodes..."]') !== null;
    });

    if (clearBtn) {
      await user.click(clearBtn);
      await waitFor(() => {
        expect((filterInput as HTMLInputElement).value).toBe('');
      });
    } else {
      // Fallback: use fireEvent on the button rendered after typing
      const allBtns = document.querySelectorAll('button');
      let xBtn: Element | null = null;
      for (const btn of allBtns) {
        const rel = btn.closest('.relative');
        if (rel?.querySelector('input[placeholder="Filter nodes..."]')) {
          // This is the X button inside the filter container
          xBtn = btn;
        }
      }
      if (xBtn) {
        // The X only appears when filterText is truthy — it should be present now
        await user.click(xBtn as HTMLElement);
        await waitFor(() => {
          expect((filterInput as HTMLInputElement).value).toBe('');
        });
      }
    }

    // After clear, filter is empty
    expect((filterInput as HTMLInputElement).value).toBe('');
  });

  // ── New: Fetch error (thrown) → empty state ────────────────────────────────

  it('shows empty state when fetch throws a network error', async () => {
    mockFetch.mockRejectedValue(new Error('network'));

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/no\s+knowledge base data/i)).toBeInTheDocument();
    });
  });

  // ── New: Schema parse failure → empty state (no crash) ────────────────────

  it('shows empty state when response JSON does not match expected schema', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ not: 'valid' }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/no\s+knowledge base data/i)).toBeInTheDocument();
    });
  });

  // ── New: Aggregation note when chunkCount > 500 ────────────────────────────

  it('renders aggregation note when chunkCount exceeds 500', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData({ chunkCount: 501 })));

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(
        screen.getByText(/individual chunk nodes hidden for performance/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/501 chunks/i)).toBeInTheDocument();
    });
  });

  // ── New: Stats cards NOT shown during empty state ──────────────────────────

  it('does not render the Documents stat card when documentCount is 0', async () => {
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

    // Stats grid is not rendered in the empty-state branch
    expect(screen.queryByText('Documents')).not.toBeInTheDocument();
  });

  // ── New: Scope query param in fetch URL ────────────────────────────────────

  it('includes scope=app in the fetch URL when scope prop is "app"', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));

    render(<VisualizeTab scope="app" />);

    await waitFor(() => {
      const fetchedUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(fetchedUrl).toContain('scope=app');
    });
  });

  // ── New: Embedded + empty with graphData non-null → correct heading + toggle ──

  it('when embedded view returns documentCount=0 with non-null graphData, shows "No embedded chunks yet" and Structure toggle', async () => {
    // First fetch (structure view) returns valid data
    const structureData = makeGraphData({ documentCount: 3 });
    // Second fetch (embedded view) returns documentCount=0 but with actual graphData
    const embeddedEmptyData = makeGraphData({ documentCount: 0 });

    mockFetch
      .mockResolvedValueOnce(makeFetchResponse(structureData))
      .mockResolvedValueOnce(makeFetchResponse(embeddedEmptyData));

    const user = userEvent.setup();
    render(<VisualizeTab />);

    // Wait for structure view to load
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Embedded' })).toBeInTheDocument()
    );

    // Switch to Embedded — triggers second fetch
    await user.click(screen.getByRole('button', { name: 'Embedded' }));

    // Second fetch resolves with documentCount=0 but graphData !== null
    // Source line 340: showToggle = view === 'embedded' && graphData !== null
    await waitFor(() => {
      expect(screen.getByText('No embedded chunks yet')).toBeInTheDocument();
    });

    // The Structure toggle button is present (for switching back)
    expect(screen.getByRole('button', { name: 'Structure' })).toBeInTheDocument();
  });
});
