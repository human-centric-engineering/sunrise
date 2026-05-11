/**
 * EmbeddingProjectionView Component Tests
 *
 * Test coverage focuses on the wrapper logic — fetch / error / empty /
 * sub-minimum / loaded states — rather than the ECharts internals.
 * The chart component itself is mocked so we can assert on the props
 * the view feeds it (series shape, colour grouping by document).
 *
 * @see components/admin/orchestration/knowledge/embedding-projection-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the dynamic ECharts import so we never actually try to render
// the chart in jsdom. The mock captures the `option` prop so tests can
// assert on series shape.
const lastChartOption: { current: unknown } = { current: null };
vi.mock('echarts-for-react', () => ({
  default: (props: { option: unknown }) => {
    lastChartOption.current = props.option;
    return <div data-testid="mock-echarts" />;
  },
}));

import { EmbeddingProjectionView } from '@/components/admin/orchestration/knowledge/embedding-projection-view';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ChartOption {
  series: Array<{
    name: string;
    type: string;
    itemStyle: { color: string };
    data: Array<{ value: [number, number]; chunk: { id: string } }>;
  }>;
  legend?: { data: string[] };
}

function makeChunk(
  id: string,
  documentId: string,
  documentName: string,
  x: number,
  y: number
): Record<string, unknown> {
  return {
    id,
    documentId,
    documentName,
    documentStatus: 'ready',
    chunkType: 'pattern_section',
    patternName: null,
    section: 'Section A',
    estimatedTokens: 200,
    contentPreview: `preview for ${id}`,
    embeddingModel: 'text-embedding-3-small',
    embeddingProvider: 'openai',
    embeddedAt: '2024-01-01T00:00:00.000Z',
    x,
    y,
  };
}

function mockProjectionResponse(
  chunks: Array<Record<string, unknown>>,
  statsOverrides: Record<string, unknown> = {}
): void {
  const stats = {
    totalEmbedded: chunks.length,
    returned: chunks.length,
    truncated: false,
    droppedMalformed: 0,
    projectable: chunks.length >= 10,
    maxChunks: 2000,
    minUsefulPoints: 10,
    ...statsOverrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { chunks, stats } }),
    })
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EmbeddingProjectionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastChartOption.current = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the computing state while the projection is fetching', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})) // never resolves
    );
    render(<EmbeddingProjectionView />);
    expect(screen.getByText(/computing umap projection/i)).toBeInTheDocument();
  });

  it('shows an empty-state when there are no embedded chunks', async () => {
    mockProjectionResponse([]);
    render(<EmbeddingProjectionView />);
    expect(await screen.findByText(/no embedded chunks to project/i)).toBeInTheDocument();
  });

  it('shows the sub-minimum warning AND renders the chart when fewer than 10 chunks are embedded', async () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`c-${i}`, 'doc-1', 'Test Doc', 0, 0)
    );
    mockProjectionResponse(chunks, { projectable: false });
    render(<EmbeddingProjectionView />);

    // The threshold copy is split across text nodes by the inline
    // <strong>10</strong> highlight, so match a phrase that lives in
    // a single text node — "to produce a meaningful 2D layout".
    expect(
      await screen.findByText(/produce a meaningful 2D layout/i, { exact: false })
    ).toBeInTheDocument();

    // The chart must still render — the warning explains WHY the
    // layout is degenerate (all points stacked at origin) but the user
    // should still see the points exist. This is the regression we
    // fixed: previously the sub-minimum branch returned early with
    // just the warning, no scatter chart at all.
    expect(screen.getByTestId('mock-echarts')).toBeInTheDocument();

    const option = lastChartOption.current as ChartOption;
    expect(option.series).toHaveLength(1);
    expect(option.series[0].data).toHaveLength(5);

    // The misleading "neighbouring points are semantically similar"
    // caption must be suppressed — at the origin, neighbours are an
    // artefact of the degenerate layout, not semantics.
    expect(screen.queryByText(/neighbouring points are semantically similar/i)).toBeNull();
  });

  it('renders the scatter chart when the projection is projectable', async () => {
    const chunks = Array.from({ length: 12 }, (_, i) =>
      makeChunk(`c-${i}`, 'doc-1', 'My Doc', i * 0.1, i * 0.2)
    );
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-echarts')).toBeInTheDocument();
    });

    const option = lastChartOption.current as ChartOption;
    // One document → one scatter series.
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe('scatter');
    expect(option.series[0].name).toBe('My Doc');
    expect(option.series[0].data).toHaveLength(12);
    // Each data point carries [x, y] from the API plus the originating chunk.
    expect(option.series[0].data[0].value).toEqual([0, 0]);
    expect(option.series[0].data[0].chunk.id).toBe('c-0');
  });

  it('groups points into one series per document and assigns distinct colours', async () => {
    const chunks = [
      ...Array.from({ length: 6 }, (_, i) => makeChunk(`a-${i}`, 'doc-1', 'Doc A', i, i)),
      ...Array.from({ length: 6 }, (_, i) => makeChunk(`b-${i}`, 'doc-2', 'Doc B', -i, -i)),
    ];
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-echarts')).toBeInTheDocument();
    });

    const option = lastChartOption.current as ChartOption;
    expect(option.series).toHaveLength(2);
    const names = option.series.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['Doc A', 'Doc B']));
    // Distinct colours per series.
    const colours = new Set(option.series.map((s) => s.itemStyle.color));
    expect(colours.size).toBe(2);
    // Legend should list the documents so users can read which colour
    // is which.
    expect(option.legend?.data).toEqual(expect.arrayContaining(['Doc A', 'Doc B']));
  });

  it('shows the truncation warning when the response is sampled', async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => makeChunk(`c-${i}`, 'doc-1', 'Doc', i, i));
    mockProjectionResponse(chunks, {
      totalEmbedded: 5000,
      returned: 12,
      truncated: true,
      maxChunks: 2000,
    });
    render(<EmbeddingProjectionView />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-echarts')).toBeInTheDocument();
    });

    expect(screen.getByText(/showing a uniform sample of/i, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/5,000 embedded/)).toBeInTheDocument();
  });

  it('shows an error state with a Try again button when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
    );
    render(<EmbeddingProjectionView />);
    expect(await screen.findByText(/failed to load embedding projection/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('forwards the scope param to the embeddings endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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
    vi.stubGlobal('fetch', fetchMock);

    render(<EmbeddingProjectionView scope="app" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/scope=app/);
  });

  it('refetches when the user clicks Recompute', async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => makeChunk(`c-${i}`, 'doc-1', 'Doc', i, i));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          chunks,
          stats: {
            totalEmbedded: 12,
            returned: 12,
            truncated: false,
            droppedMalformed: 0,
            projectable: true,
            maxChunks: 2000,
            minUsefulPoints: 10,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<EmbeddingProjectionView />);
    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /recompute/i }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
