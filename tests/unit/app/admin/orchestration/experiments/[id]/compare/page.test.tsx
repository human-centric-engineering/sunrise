// @vitest-environment happy-dom

/**
 * Unit Tests: ExperimentComparePage
 *
 * Tests the admin "Compare variants" server component page.
 *
 * Test Coverage:
 * - notFound() path — compare data missing (res 404, res.ok false, success false, fetch throws)
 * - Happy path — renders heading, variant/metric counts, PairwiseVerdictCard + VariantCompareTable
 * - "No comparison data yet" branch when no variant has an evaluation run
 * - "Some variant runs still queued" notice when a run is not yet completed
 * - Judge-list fetch tolerance — page still renders with an empty judge list on failure
 * - serverFetch called with the correct compare endpoint
 *
 * @see app/admin/orchestration/experiments/[id]/compare/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Stub the two presentational children so we can inspect the props the page wires.
vi.mock('@/components/admin/orchestration/experiments/pairwise-verdict-card', () => ({
  PairwiseVerdictCard: (props: {
    experimentId: string;
    judges: Array<{ slug: string; name: string }>;
    variants: unknown[];
    caseCount: number | null;
  }) => (
    <div
      data-testid="pairwise-verdict-card"
      data-experiment-id={props.experimentId}
      data-judge-count={props.judges.length}
      data-variant-count={props.variants.length}
      data-case-count={String(props.caseCount)}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/experiments/variant-compare-table', () => ({
  VariantCompareTable: (props: { variants: unknown[]; metricSlugs: string[] }) => (
    <div
      data-testid="variant-compare-table"
      data-variant-count={props.variants.length}
      data-metric-count={props.metricSlugs.length}
    />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import ExperimentComparePage from '@/app/admin/orchestration/experiments/[id]/compare/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { API } from '@/lib/api/endpoints';

// ─── Test data ──────────────────────────────────────────────────────────────

interface VariantRow {
  variantId: string;
  label: string;
  evaluationRunId: string | null;
  runStatus: string | null;
  rawScores: Record<string, number[]>;
  meanByMetric: Record<string, number | null>;
}

function makeVariant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    variantId: 'var-1',
    label: 'Variant A',
    evaluationRunId: 'run-1',
    runStatus: 'completed',
    rawScores: { faithfulness: [0.8, 0.9] },
    meanByMetric: { faithfulness: 0.85 },
    ...overrides,
  };
}

function makeCompareData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    experimentName: 'Prompt tweak A/B',
    variants: [
      makeVariant({ variantId: 'var-1', label: 'Variant A' }),
      makeVariant({ variantId: 'var-2', label: 'Variant B' }),
    ],
    metricSlugs: ['faithfulness', 'relevance'],
    caseCount: 12,
    pairwiseVerdict: null,
    ...overrides,
  };
}

const COMPARE = '__compare__';
const GRADERS = '__graders__';

/**
 * Routes the two parallel fetches the page fires. `serverFetch` returns a
 * tagged stub per URL; `parseApiResponse` reads the tag to return the matching
 * parsed body. `compareResult` / `gradersResult` are the parsed envelopes.
 */
function wireFetches({
  compareStatus = 200,
  compareOk = true,
  compareResult,
  gradersOk = true,
  gradersResult,
}: {
  compareStatus?: number;
  compareOk?: boolean;
  compareResult?: unknown;
  gradersOk?: boolean;
  gradersResult?: unknown;
}) {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes('/compare')) {
      return { ok: compareOk, status: compareStatus, __tag: COMPARE } as unknown as Response;
    }
    return { ok: gradersOk, status: gradersOk ? 200 : 500, __tag: GRADERS } as unknown as Response;
  });
  vi.mocked(parseApiResponse).mockImplementation(async (res: Response) => {
    const tag = (res as unknown as { __tag: string }).__tag;
    if (tag === COMPARE) return compareResult as never;
    return gradersResult as never;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExperimentComparePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── notFound paths ─────────────────────────────────────────────────────────

  describe('notFound behavior', () => {
    it('calls notFound when the compare endpoint returns 404', async () => {
      wireFetches({ compareStatus: 404, compareOk: false });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it('calls notFound and warns when the compare fetch is non-ok', async () => {
      wireFetches({ compareStatus: 500, compareOk: false });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(logger.warn).toHaveBeenCalledWith(
        'Experiment compare: fetch failed',
        expect.objectContaining({ id: 'exp-1', status: 500 })
      );
    });

    it('calls notFound when the parsed compare envelope is unsuccessful', async () => {
      wireFetches({
        compareResult: { success: false, error: { code: 'X', message: 'no' } },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it('calls notFound and logs when the compare fetch throws', async () => {
      const boom = new Error('Network down');
      vi.mocked(serverFetch).mockImplementation(async (url: string) => {
        if (url.includes('/compare')) throw boom;
        return { ok: true, status: 200, __tag: GRADERS } as unknown as Response;
      });
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { judgeAgents: [] },
      } as never);
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(logger.error).toHaveBeenCalledWith(
        'Experiment compare: fetch threw',
        expect.objectContaining({ id: 'exp-1', error: 'Network down' })
      );
    });
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  describe('serverFetch endpoint', () => {
    it('fetches the compare endpoint for the requested experiment id', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData() },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-42' });

      render(await ExperimentComparePage({ params }));

      expect(serverFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.experimentCompareById('exp-42')
      );
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders the experiment name and the compare table + verdict card with wired props', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData({ caseCount: 12 }) },
        gradersResult: {
          success: true,
          data: { judgeAgents: [{ slug: 'gpt-judge', name: 'GPT Judge' }] },
        },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByRole('heading', { name: 'Prompt tweak A/B' })).toBeInTheDocument();

      const table = screen.getByTestId('variant-compare-table');
      expect(table).toHaveAttribute('data-variant-count', '2');
      expect(table).toHaveAttribute('data-metric-count', '2');

      const verdict = screen.getByTestId('pairwise-verdict-card');
      expect(verdict).toHaveAttribute('data-experiment-id', 'exp-1');
      expect(verdict).toHaveAttribute('data-judge-count', '1');
      expect(verdict).toHaveAttribute('data-variant-count', '2');
      expect(verdict).toHaveAttribute('data-case-count', '12');
    });

    it('uses singular nouns when there is exactly one variant and one metric', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [makeVariant()],
            metricSlugs: ['faithfulness'],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByText(/1 variant · 1 metric/)).toBeInTheDocument();
    });
  });

  // ── Empty / partial-run branches ────────────────────────────────────────────

  describe('run-state branches', () => {
    it('shows "No comparison data yet" and hides the compare table when no variant has a run', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [
              makeVariant({ variantId: 'var-1', evaluationRunId: null, runStatus: null }),
              makeVariant({ variantId: 'var-2', evaluationRunId: null, runStatus: null }),
            ],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByText('No comparison data yet')).toBeInTheDocument();
      expect(screen.queryByTestId('variant-compare-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pairwise-verdict-card')).not.toBeInTheDocument();
    });

    it('shows the "still queued" notice when a variant run has not completed', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [
              makeVariant({ variantId: 'var-1', runStatus: 'completed' }),
              makeVariant({ variantId: 'var-2', evaluationRunId: 'run-2', runStatus: 'running' }),
            ],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByText(/Some variant runs are still queued or running/)).toBeInTheDocument();
      // The table still renders against whatever has completed
      expect(screen.getByTestId('variant-compare-table')).toBeInTheDocument();
    });
  });

  // ── Judge-list tolerance ─────────────────────────────────────────────────────

  describe('judge-list fetch tolerance', () => {
    it('renders with an empty judge list and warns when the graders fetch is non-ok', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData() },
        gradersOk: false,
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByTestId('pairwise-verdict-card')).toHaveAttribute('data-judge-count', '0');
      expect(logger.warn).toHaveBeenCalledWith(
        'Experiment compare: judge list fetch failed',
        expect.objectContaining({ status: 500 })
      );
    });
  });
});
