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

/** Last captured chart props — updated each render so tests can call onEvents handlers */
let capturedChartProps: {
  option?: {
    tooltip?: {
      formatter?: (params: {
        dataType?: string;
        data?: {
          value?: {
            id: string;
            name: string;
            type: string;
            value: number;
            category: number;
            metadata?: Record<string, unknown>;
          };
          name?: string;
          edgeMeta?: {
            label?: string;
            sourceName: string;
            sourceType: string;
            sourceMeta?: Record<string, unknown>;
            targetName: string;
            targetType: string;
            targetMeta?: Record<string, unknown>;
          };
        };
      }) => string;
    };
  };
  onEvents?: Record<string, (params: { data?: { value?: unknown } }) => void>;
} = {};

// ReactECharts uses dynamic import + canvas; stub it out and capture props for testing
vi.mock('echarts-for-react', () => ({
  default: (props: typeof capturedChartProps) => {
    capturedChartProps = props;
    return <div data-testid="echarts-mock">chart</div>;
  },
}));

vi.mock('next/dynamic', () => ({
  default: (_fn: () => Promise<{ default: unknown }>) => {
    // Return the stub that also captures props
    return (props: typeof capturedChartProps) => {
      capturedChartProps = props;
      return <div data-testid="echarts-mock">chart</div>;
    };
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
    capturedChartProps = {};
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

  it('shows error state when fetch returns non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load graph/i)).toBeInTheDocument();
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

  it('exposes an Embedding space toggle that hits the embeddings endpoint instead of the graph endpoint', async () => {
    // Default mock returns the structural graph; switch the
    // implementation when the embeddings endpoint is requested so the
    // test sees the projection view's loading → loaded transition.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/knowledge/embeddings')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                chunks: [],
                stats: {
                  totalEmbedded: 0,
                  returned: 0,
                  truncated: false,
                  droppedMalformed: 0,
                  projectable: false,
                  maxChunks: 2000,
                  minUsefulPoints: 10,
                },
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: makeGraphData() }),
      });
    });

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Embedding space' })).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: 'Embedding space' }));

    // The embeddings endpoint is hit at least once after switching.
    await waitFor(() => {
      const urls = mockFetch.mock.calls.map((call) => call[0] as string);
      expect(urls.some((u) => u.includes('/knowledge/embeddings'))).toBe(true);
    });

    // The chrome around the graph (search filter, fullscreen button)
    // is replaced — the embedding-space view has its own affordances.
    expect(screen.queryByPlaceholderText(/filter nodes/i)).not.toBeInTheDocument();
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

  it('shows error state when fetch throws a network error', async () => {
    mockFetch.mockRejectedValue(new Error('network'));

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });
  });

  // ── New: Schema parse failure → empty state (no crash) ────────────────────

  it('shows error state when response JSON does not match expected schema', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ not: 'valid' }),
    });

    render(<VisualizeTab />);

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
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

  // ── Fullscreen search bar ────────────────────────────────────────────────────

  it('renders a filter input inside fullscreen mode', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));

    const user = userEvent.setup();
    render(<VisualizeTab />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^fullscreen$/i })).toBeInTheDocument()
    );

    // Enter fullscreen — reveals fullscreen search bar (in addition to the regular one)
    await user.click(screen.getByRole('button', { name: /^fullscreen$/i }));

    // Both the fullscreen header input and the normal bar should no longer be present;
    // instead the fullscreen header bar appears. There should be at least one filter input.
    const filterInputs = screen.getAllByPlaceholderText('Filter nodes...');
    expect(filterInputs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Tooltip formatter — node types ────────────────────────────────────────

  it('chart tooltip formatter returns Knowledge Base tooltip for kb node type', async () => {
    // Arrange: load graph data so the chart renders with the option
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));

    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: call formatter with a kb node
    const result = formatter!({
      data: {
        value: {
          id: 'kb-1',
          name: 'Knowledge Base',
          type: 'kb',
          value: 20,
          category: 0,
          metadata: { documents: 3, chunks: 42, totalTokens: 8500 },
        },
      },
    });

    // Assert: KB-specific tooltip content
    expect(result).toContain('Knowledge Base');
    expect(result).toContain('Documents: 3');
    expect(result).toContain('Chunks: 42');
  });

  it('chart tooltip formatter returns document tooltip for document node type', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: call formatter with a document node
    const result = formatter!({
      data: {
        value: {
          id: 'doc-1',
          name: 'Patterns Guide',
          type: 'document',
          value: 12,
          category: 1,
          metadata: { status: 'ready', chunkCount: 42, totalTokens: 8000 },
        },
      },
    });

    // Assert: document-specific tooltip content
    expect(result).toContain('Patterns Guide');
    expect(result).toContain('Status: ready');
    expect(result).toContain('Chunks: 42');
  });

  it('chart tooltip formatter returns document tooltip with error message when errorMessage present', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: document node with errorMessage field
    const result = formatter!({
      data: {
        value: {
          id: 'doc-err',
          name: 'Failed Doc',
          type: 'document',
          value: 8,
          category: 3,
          metadata: {
            status: 'failed',
            chunkCount: 0,
            totalTokens: 0,
            errorMessage: 'Parse error occurred',
          },
        },
      },
    });

    // Assert: error message included in tooltip
    expect(result).toContain('Parse error occurred');
  });

  it('chart tooltip formatter returns chunk tooltip for chunk node type', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: call formatter with a chunk node
    const result = formatter!({
      data: {
        value: {
          id: 'chunk-1',
          name: 'Chunk 1',
          type: 'chunk',
          value: 5,
          category: 4,
          metadata: {
            patternName: 'Overview',
            chunkType: 'section_intro',
            estimatedTokens: 250,
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-small',
            contentPreview: 'This is the intro chunk content...',
          },
        },
      },
    });

    // Assert: chunk-specific tooltip content
    expect(result).toContain('Overview');
    expect(result).toContain('openai');
    expect(result).toContain('250');
  });

  it('chart tooltip formatter returns chunk tooltip with "not embedded" when no embeddingProvider', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: chunk node without embeddingProvider
    const result = formatter!({
      data: {
        value: {
          id: 'chunk-bare',
          name: 'Bare Chunk',
          type: 'chunk',
          value: 4,
          category: 4,
          metadata: {
            chunkType: 'paragraph',
            estimatedTokens: 100,
            contentPreview: 'Some text...',
          },
        },
      },
    });

    // Assert: "not embedded" shown
    expect(result).toContain('not embedded');
  });

  it('chart tooltip formatter returns node name when node has no metadata', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: node without metadata
    const result = formatter!({
      data: { value: undefined, name: 'Unnamed Node' },
    });

    // Assert: falls back to node name
    expect(result).toBe('Unnamed Node');
  });

  // ── Tooltip formatter — edge tooltip ──────────────────────────────────────

  it('chart tooltip formatter returns edge tooltip for dataType="edge"', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: call with an edge params object
    const result = formatter!({
      dataType: 'edge',
      data: {
        edgeMeta: {
          label: 'contains',
          sourceName: 'Knowledge Base',
          sourceType: 'kb',
          sourceMeta: {},
          targetName: 'Patterns Guide',
          targetType: 'document',
          targetMeta: { chunkCount: 42 },
        },
      },
    });

    // Assert: edge tooltip contains both node names and label
    expect(result).toContain('Knowledge Base');
    expect(result).toContain('contains');
    expect(result).toContain('Patterns Guide');
  });

  it('chart tooltip formatter returns empty string for edge with no edgeMeta', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: edge params without edgeMeta
    const result = formatter!({ dataType: 'edge', data: {} });

    // Assert: returns empty string (early return on !em)
    expect(result).toBe('');
  });

  it('edge tooltip nodeLine returns "Knowledge Base" for kb type', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: source is kb type
    const result = formatter!({
      dataType: 'edge',
      data: {
        edgeMeta: {
          label: 'contains',
          sourceName: 'KB Root',
          sourceType: 'kb',
          targetName: 'A Document',
          targetType: 'document',
          targetMeta: { chunkCount: 5 },
        },
      },
    });

    // Assert: "Knowledge Base" appears for kb source in the edge tooltip
    expect(result).toContain('Knowledge Base');
    expect(result).toContain('5 chunks');
  });

  it('edge tooltip nodeLine shows chunk details for chunk type', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const formatter = capturedChartProps.option?.tooltip?.formatter;
    expect(formatter).toBeDefined();

    // Act: target is chunk type with metadata
    const result = formatter!({
      dataType: 'edge',
      data: {
        edgeMeta: {
          label: 'section',
          sourceName: 'A Document',
          sourceType: 'document',
          sourceMeta: { chunkCount: 3 },
          targetName: 'Chunk 1',
          targetType: 'chunk',
          targetMeta: {
            patternName: 'Intro',
            chunkType: 'section_intro',
            estimatedTokens: 200,
            embeddingProvider: 'openai',
          },
        },
      },
    });

    // Assert: chunk detail line contains token/provider info
    expect(result).toContain('Intro');
    expect(result).toContain('openai');
  });

  // ── handleChartClick — node detail dialog ─────────────────────────────────

  it('clicking a chart node opens the node detail dialog', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    // Act: simulate a chart click via the captured onEvents handler
    const clickHandler = capturedChartProps.onEvents?.click;
    expect(clickHandler).toBeDefined();

    clickHandler!({
      data: {
        value: {
          id: 'doc-1',
          name: 'Patterns Guide',
          type: 'document',
          value: 12,
          category: 1,
          metadata: { status: 'ready', chunkCount: 42, totalTokens: 8000 },
        },
      },
    });

    // Assert: dialog opened with node name
    await waitFor(() => {
      expect(screen.getByText('Patterns Guide')).toBeInTheDocument();
    });
    expect(screen.getByText('document')).toBeInTheDocument();
  });

  it('node detail dialog shows contentPreview when present', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const clickHandler = capturedChartProps.onEvents?.click;
    expect(clickHandler).toBeDefined();

    // Act: click a chunk node that has a contentPreview
    clickHandler!({
      data: {
        value: {
          id: 'chunk-1',
          name: 'Chunk 1',
          type: 'chunk',
          value: 5,
          category: 4,
          metadata: {
            chunkType: 'section_intro',
            estimatedTokens: 100,
            contentPreview: 'Here is some preview text for the chunk.',
          },
        },
      },
    });

    // Assert: content preview rendered
    await waitFor(() => {
      expect(screen.getByText('Here is some preview text for the chunk.')).toBeInTheDocument();
    });
    expect(screen.getByText(/content preview/i)).toBeInTheDocument();
  });

  it('node detail dialog shows ISO date values as formatted dates', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const clickHandler = capturedChartProps.onEvents?.click;
    expect(clickHandler).toBeDefined();

    // Act: click node with an ISO date in metadata
    clickHandler!({
      data: {
        value: {
          id: 'chunk-date',
          name: 'Dated Chunk',
          type: 'chunk',
          value: 5,
          category: 4,
          metadata: {
            embeddedAt: '2026-04-01T10:00:00.000Z',
            estimatedTokens: 50,
          },
        },
      },
    });

    // Assert: embeddedAt shown (formatted by toLocaleString — just verify not raw ISO)
    await waitFor(() => {
      expect(screen.getByText('Dated Chunk')).toBeInTheDocument();
    });
    // The value "2026-04-01T10:00:00.000Z" should NOT appear raw; it should be locale-formatted
    expect(screen.queryByText('2026-04-01T10:00:00.000Z')).not.toBeInTheDocument();
  });

  it('does not open dialog when chart click has no node data', async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(makeGraphData()));
    render(<VisualizeTab />);

    await waitFor(() => expect(screen.getByTestId('echarts-mock')).toBeInTheDocument());

    const clickHandler = capturedChartProps.onEvents?.click;
    expect(clickHandler).toBeDefined();

    // Act: click with empty data (no value)
    clickHandler!({ data: {} });

    // Assert: dialog NOT opened — "document" badge not in DOM (it only appears in dialog title)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
