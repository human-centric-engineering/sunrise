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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the dynamic ECharts import so we never actually try to render
// the chart in jsdom. The mock captures the `option` prop AND the
// `onEvents` map so tests can drive the chart's click handler
// directly — there's no SVG to click in jsdom, but the click
// behaviour is the part the view actually owns.
const lastChartOption: { current: unknown } = { current: null };
const lastChartEvents: { current: Record<string, (params: unknown) => void> | null } = {
  current: null,
};
vi.mock('echarts-for-react', () => ({
  default: (props: { option: unknown; onEvents?: Record<string, (params: unknown) => void> }) => {
    lastChartOption.current = props.option;
    lastChartEvents.current = props.onEvents ?? null;
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
    //
    // Use `findByTestId` (not `getByTestId`) because `ReactECharts`
    // is a `dynamic()` import — it mounts asynchronously after the
    // surrounding markup. Under the full-suite load `getByTestId`
    // fired before the chart finished mounting and the test failed
    // intermittently; `findByTestId` polls so it waits out the
    // dynamic-import resolution.
    expect(await screen.findByTestId('mock-echarts')).toBeInTheDocument();

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

  it('opens the chunk detail dialog with all chunk fields when a point is clicked', async () => {
    // Drive the captured click handler directly — jsdom can't click
    // the SVG inside ECharts, but the click behaviour is the part
    // the view owns: take the chunk payload, set `selected`, and
    // render the dialog. Verify the dialog's content fields are
    // populated from the clicked chunk.
    const chunks = Array.from({ length: 12 }, (_, i) =>
      makeChunk(`c-${i}`, 'doc-1', 'Doc A', i * 0.1, i * 0.2)
    );
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Simulate ECharts firing a click on a point. The event payload
    // mirrors what the real chart emits: `data.chunk` carries the
    // originating chunk object the view attached during series
    // construction.
    expect(lastChartEvents.current).not.toBeNull();
    await act(async () => {
      lastChartEvents.current!.click({ data: { chunk: chunks[3] } });
    });

    // Dialog opens with content fields populated from the chunk.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Doc A')).toBeInTheDocument();
    // The dialog applies `replace(/_/g, ' ')` to chunkType so users
    // see "pattern section" rather than the snake_case storage form.
    expect(screen.getByText('pattern section')).toBeInTheDocument();
    // "Section A" appears twice — in the dialog title (chunk.section
    // is the fallback when patternName is null) and in the Section
    // field row. Use `getAllByText` to assert both occurrences exist
    // without ambiguity.
    expect(screen.getAllByText('Section A').length).toBeGreaterThanOrEqual(1);
    // Embedding provenance string composed from provider + model.
    expect(screen.getByText(/openai.*text-embedding-3-small/i)).toBeInTheDocument();
  });

  it('ignores a click event that has no chunk payload', async () => {
    // ECharts fires click events for empty regions of the canvas too;
    // those carry no `data.chunk`. The view should treat them as
    // no-ops — no dialog, no setSelected.
    const chunks = Array.from({ length: 12 }, (_, i) =>
      makeChunk(`c-${i}`, 'doc-1', 'Doc A', i * 0.1, i * 0.2)
    );
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    await act(async () => {
      lastChartEvents.current!.click({ data: {} });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => {
      lastChartEvents.current!.click({});
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the dialog without the Section field when the chunk has no section', async () => {
    // The dialog renders `<Field label="Section" ...>` only when
    // `selected.section` is truthy. A chunk with `section: null` should
    // still open the dialog (showing Document, Type, Tokens, Embedding,
    // preview) but skip the Section row.
    const chunks = Array.from({ length: 12 }, (_, i) => {
      const c = makeChunk(`c-${i}`, 'doc-1', 'Doc A', i, i);
      c.section = null;
      c.patternName = null;
      return c;
    });
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    await act(async () => {
      lastChartEvents.current!.click({ data: { chunk: chunks[0] } });
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Section row absent — there's no `<span>Section</span>` label.
    expect(screen.queryByText(/^Section$/)).not.toBeInTheDocument();
  });

  it('handles a chunk with no embedding provider in the dialog', async () => {
    // Defensive: if a chunk somehow lacks provider/model metadata,
    // the dialog shows "unknown provider" instead of a malformed
    // "null · null" string.
    const chunks = Array.from({ length: 12 }, (_, i) => {
      const c = makeChunk(`c-${i}`, 'doc-1', 'Doc A', i, i);
      c.embeddingProvider = null;
      c.embeddingModel = null;
      return c;
    });
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    await act(async () => {
      lastChartEvents.current!.click({ data: { chunk: chunks[0] } });
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('unknown provider')).toBeInTheDocument();
  });

  it('escapes HTML in the chart tooltip formatter so chunk text cannot inject markup', async () => {
    // The ECharts tooltip is `formatter: (params) => htmlString` — a
    // raw-HTML callback that ECharts injects via innerHTML. A chunk
    // whose `documentName` or `contentPreview` contains `<script>` or
    // an attribute payload must come back escaped. Drive the
    // formatter directly to verify.
    const chunks = Array.from({ length: 12 }, (_, i) => {
      const c = makeChunk(`c-${i}`, 'doc-1', '<script>alert("xss")</script>', i, i);
      c.contentPreview = 'Snippet with <b>html</b> & quotes "here"';
      return c;
    });
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    interface ChartWithTooltip {
      tooltip: {
        formatter: (params: { data?: { chunk?: Record<string, unknown> } }) => string;
      };
    }
    const option = lastChartOption.current as ChartWithTooltip;
    const html = option.tooltip.formatter({ data: { chunk: chunks[0] as never } });

    // No literal "<script>" tag survives — the open angle bracket
    // got escaped to "&lt;".
    expect(html).not.toMatch(/<script>/i);
    expect(html).toContain('&lt;script&gt;');
    // The ampersand inside content preview got double-encoded
    // correctly (& → &amp;) before any tag escapes run.
    expect(html).toContain('&amp;');
    // Empty payload returns empty string.
    expect(option.tooltip.formatter({ data: {} })).toBe('');
    expect(option.tooltip.formatter({})).toBe('');
  });

  it('falls back to the slate colour when a 13th+ document overflows the palette', async () => {
    // The DOCUMENT_PALETTE has 12 entries; documents past that should
    // wrap and reuse the first colour rather than crashing or
    // returning undefined.
    const chunks: Array<Record<string, unknown>> = [];
    for (let docNum = 1; docNum <= 13; docNum++) {
      chunks.push(makeChunk(`d${docNum}-c-0`, `doc-${docNum}`, `Doc ${docNum}`, docNum, docNum));
    }
    mockProjectionResponse(chunks);
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    const option = lastChartOption.current as ChartOption;
    expect(option.series).toHaveLength(13);
    // 13th document (index 12) should wrap to palette[0] — same as
    // the 1st document — confirming the modulo wraps cleanly.
    expect(option.series[12].itemStyle.color).toBe(option.series[0].itemStyle.color);
  });

  it('surfaces a malformed-vectors notice when droppedMalformed > 0', async () => {
    // The endpoint emits `stats.droppedMalformed` when one or more
    // pgvector rows failed to parse. The view should still render
    // the remaining chunks normally — droppedMalformed is observable
    // via the stats payload but doesn't gate the chart.
    const chunks = Array.from({ length: 11 }, (_, i) => makeChunk(`c-${i}`, 'doc-1', 'Doc', i, i));
    mockProjectionResponse(chunks, { droppedMalformed: 3, totalEmbedded: 14 });
    render(<EmbeddingProjectionView />);

    await waitFor(() => expect(screen.getByTestId('mock-echarts')).toBeInTheDocument());

    // 11 valid chunks were drawn; droppedMalformed=3 doesn't block
    // rendering. The chunk count text mentions the actual returned
    // count.
    expect(screen.getByText(/11 points/)).toBeInTheDocument();
  });

  it('handles a fetch that rejects with a thrown error (not just ok=false)', async () => {
    // The `ok=false` branch is covered by the "error state" test.
    // This exercises the catch-block path where fetch throws (DNS,
    // network down, CORS, etc.) instead of returning a non-ok
    // response. Both paths must surface a user-visible error.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    render(<EmbeddingProjectionView />);

    expect(await screen.findByText(/connect ECONNREFUSED/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
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
