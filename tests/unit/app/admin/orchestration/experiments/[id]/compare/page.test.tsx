// @vitest-environment happy-dom

/**
 * Unit Tests: ExperimentComparePage
 *
 * Tests the admin "Compare variants" server component page.
 *
 * Test Coverage:
 * - notFound() only on a compare 404; a 500, an error envelope or a network
 *   error throws ServerLoadError to the error boundary (#518)
 * - Happy path — renders heading, variant/metric counts, PairwiseVerdictCard + VariantCompareTable
 * - "No comparison data yet" branch when no variant has an evaluation run
 * - "Some variant runs still queued" notice when a run is still queued or running
 * - Judge-list failure — a notice above the verdict card, which still renders
 * - serverFetch called with the correct compare endpoint
 *
 * @see app/admin/orchestration/experiments/[id]/compare/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
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

/** A real `Response` carrying `envelope` as its body. */
function envelopeResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Routes the two parallel fetches the page fires to real `Response`s.
 * `compareResult` / `gradersResult` are the envelopes the API answers with;
 * a non-200 status without an envelope answers with an error envelope.
 */
function wireFetches({
  compareStatus = 200,
  compareResult,
  gradersStatus = 200,
  gradersResult = { success: true, data: { judgeAgents: [] } },
}: {
  compareStatus?: number;
  compareResult?: unknown;
  gradersStatus?: number;
  gradersResult?: unknown;
}) {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    if (url.includes('/compare')) {
      return compareResult === undefined
        ? apiFailure(compareStatus, compareStatus === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR')
        : envelopeResponse(compareResult, compareStatus);
    }
    return gradersStatus === 200 ? envelopeResponse(gradersResult) : apiFailure(gradersStatus);
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
      wireFetches({ compareStatus: 404 });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it('throws ServerLoadError, not notFound, and logs when the compare fetch fails', async () => {
      wireFetches({ compareStatus: 500 });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed',
        undefined,
        expect.objectContaining({
          path: API.ADMIN.ORCHESTRATION.experimentCompareById('exp-1'),
          status: 500,
        })
      );
    });

    it('throws ServerLoadError when the compare envelope is unsuccessful', async () => {
      wireFetches({ compareResult: { success: false, error: { code: 'X', message: 'no' } } });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
    });

    it('throws ServerLoadError and logs when the compare fetch throws', async () => {
      const boom = new Error('Network down');
      vi.mocked(serverFetch).mockImplementation(async (url: string) => {
        if (url.includes('/compare')) throw boom;
        return apiSuccess({ judgeAgents: [] });
      });
      const params = Promise.resolve({ id: 'exp-1' });

      await expect(ExperimentComparePage({ params })).rejects.toBeInstanceOf(ServerLoadError);
      expect(notFound).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed: no response',
        boom,
        expect.objectContaining({ path: API.ADMIN.ORCHESTRATION.experimentCompareById('exp-1') })
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
        API.ADMIN.ORCHESTRATION.experimentCompareById('exp-42'),
        undefined
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
    it('does not show the "still queued" notice for a variant run that ended failed', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [
              makeVariant({ variantId: 'var-1', runStatus: 'completed' }),
              makeVariant({ variantId: 'var-2', evaluationRunId: 'run-2', runStatus: 'failed' }),
            ],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(
        screen.queryByText(/Some variant runs are still queued or running/)
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('variant-compare-table')).toBeInTheDocument();
      expect(screen.getByText(/Some variant runs failed or were cancelled/)).toBeInTheDocument();
    });

    it('still shows the "still queued" notice for a run status it does not recognise', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [
              makeVariant({ variantId: 'var-1', runStatus: 'completed' }),
              makeVariant({ variantId: 'var-2', evaluationRunId: 'run-2', runStatus: 'queued' }),
              makeVariant({ variantId: 'var-3', evaluationRunId: 'run-3', runStatus: 'pending' }),
            ],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByText(/Some variant runs are still queued or running/)).toBeInTheDocument();
    });

    it('treats a cancelled run as finished, not queued', async () => {
      wireFetches({
        compareResult: {
          success: true,
          data: makeCompareData({
            variants: [
              makeVariant({ variantId: 'var-1', runStatus: 'completed' }),
              makeVariant({ variantId: 'var-2', evaluationRunId: 'run-2', runStatus: 'cancelled' }),
            ],
          }),
        },
        gradersResult: { success: true, data: { judgeAgents: [] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(
        screen.queryByText(/Some variant runs are still queued or running/)
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Some variant runs failed or were cancelled/)).toBeInTheDocument();
    });
  });

  // ── Judge-list tolerance ─────────────────────────────────────────────────────

  describe('judge-list failure', () => {
    it('shows a notice above the verdict card when the graders fetch fails', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData() },
        gradersStatus: 500,
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load judge agents for the pairwise verdict/i
      );
      // The card still shows any existing verdict; it gets no judges to pick from.
      expect(screen.getByTestId('pairwise-verdict-card')).toHaveAttribute('data-judge-count', '0');
      expect(screen.getByTestId('variant-compare-table')).toBeInTheDocument();
    });

    it('shows the notice, not an error page, when the graders reply has no judge list', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData() },
        gradersResult: { success: true, data: {} },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load judge agents for the pairwise verdict/i
      );
      expect(screen.getByTestId('variant-compare-table')).toBeInTheDocument();
    });

    it('shows no notice when the graders fetch succeeds', async () => {
      wireFetches({
        compareResult: { success: true, data: makeCompareData() },
        gradersResult: { success: true, data: { judgeAgents: [{ slug: 'j', name: 'J' }] } },
      });
      const params = Promise.resolve({ id: 'exp-1' });

      render(await ExperimentComparePage({ params }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
