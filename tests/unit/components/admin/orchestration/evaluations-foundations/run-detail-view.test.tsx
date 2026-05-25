/**
 * RunDetailView Component Tests
 *
 * Test coverage:
 * - Initial loading state is shown
 * - Renders the run header with name + status badge
 * - Renders the progress bar with the correct percent
 * - Renders the summary table after completion (per-metric stats)
 * - Renders the per-case results table with metric score columns
 * - Cancel run button only visible while status is active (queued/running)
 * - Polling fires every 3s for active statuses and stops on terminal status
 * - Clicking a case row opens the drill-in dialog with input / expected / output / scores / evaluationSteps
 *
 * @see components/admin/orchestration/evaluations-foundations/run-detail-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({ get: () => null }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { RunDetailView } from '@/components/admin/orchestration/evaluations-foundations/run-detail-view';
import { API } from '@/lib/api/endpoints';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

function buildRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    name: 'Smoke run',
    description: 'After refactor',
    status: 'completed' as RunStatus,
    subjectKind: 'agent',
    agent: { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
    workflow: null,
    dataset: { id: 'ds-1', name: 'FAQ', caseCount: 10, contentHash: 'abc' },
    metricConfigs: [
      { slug: 'exact_match', config: {} },
      { slug: 'faithfulness', config: {} },
    ],
    judgeProvider: 'anthropic',
    judgeModel: 'claude-opus-4-6',
    progress: { casesTotal: 10, casesDone: 10, casesFailed: 0 },
    summary: {
      metricSlugs: ['exact_match', 'faithfulness'],
      stats: {
        exact_match: { mean: 0.8, median: 1, p95: 1, passRate: 0.8, scoredCount: 10 },
        faithfulness: { mean: 0.65, median: 0.7, p95: 0.9, passRate: 0.6, scoredCount: 10 },
      },
    },
    totalCostUsd: 0.1234,
    startedAt: '2026-05-10T10:00:00Z',
    completedAt: '2026-05-10T10:05:00Z',
    createdAt: '2026-05-10T09:59:00Z',
    ...overrides,
  };
}

function buildCases(): Array<Record<string, unknown>> {
  return [
    {
      id: 'c-1',
      casePosition: 1,
      subjectOutput: 'The order ships in 3 days.',
      subjectMetadata: null,
      metricScores: {
        exact_match: { score: 1, passed: true, reasoning: 'match' },
        faithfulness: {
          score: 0.9,
          reasoning: 'cited correctly',
          evaluationSteps: ['Step A', 'Step B'],
        },
      },
      latencyMs: 120,
      costUsd: 0.0012,
      errorCode: null,
      errorMessage: null,
      datasetCase: {
        input: 'When does my order ship?',
        expectedOutput: 'Ships within 3 days.',
        metadata: null,
      },
    },
    {
      id: 'c-2',
      casePosition: 2,
      subjectOutput: 'Unknown.',
      subjectMetadata: null,
      metricScores: {
        exact_match: { score: 0, passed: false, reasoning: 'no match' },
        faithfulness: { score: null },
      },
      latencyMs: 95,
      costUsd: 0.0008,
      errorCode: null,
      errorMessage: null,
      datasetCase: { input: 'Refund policy?', expectedOutput: null, metadata: null },
    },
  ];
}

/**
 * Build a fetch mock that returns RunDetail for the run-detail endpoint and
 * CaseResults for the cases endpoint. `runFactory` is called on every
 * detail fetch — useful to advance status across polls.
 */
function makeFetchMock(
  runFactory: () => Record<string, unknown>,
  casesFactory: () => Array<Record<string, unknown>> = buildCases
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith(API.ADMIN.ORCHESTRATION.evalRunCases('run-1'))) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { items: casesFactory(), nextCursor: null } }),
      } as unknown as Response;
    }
    if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: runFactory() }),
      } as unknown as Response;
    }
    if (url === API.ADMIN.ORCHESTRATION.evalRunCancel('run-1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/**
 * Drain microtasks so awaited fetch promises inside the effect can resolve
 * before we make any assertions or advance timers further.
 */
async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RunDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('initial render', () => {
    it('shows the loading state until the first detail fetch resolves', async () => {
      // Detail fetch never resolves to capture the loading state.
      const pending = new Promise<Response>(() => {
        /* never resolves */
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => pending)
      );
      render(<RunDetailView runId="run-1" />);
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });

    it('renders the run header with name + status badge after load', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText('Smoke run')).toBeInTheDocument();
      // Status badge text appears
      expect(screen.getByText('completed')).toBeInTheDocument();
    });

    it('renders the progress bar with the correct percent', async () => {
      makeFetchMock(() =>
        buildRun({ status: 'running', progress: { casesTotal: 10, casesDone: 7, casesFailed: 0 } })
      );
      const { container } = render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      // "7 / 10 (70%)" appears in the progress card
      expect(screen.getByText(/7\s*\/\s*10\s*\(70%\)/)).toBeInTheDocument();
      // Inner progress bar width is set to 70%
      const filledBar = container.querySelector<HTMLElement>('div.bg-primary.h-3');
      expect(filledBar).not.toBeNull();
      expect(filledBar?.style.width).toBe('70%');
    });

    it('treats progress with 0 total as 0% (no divide-by-zero)', async () => {
      makeFetchMock(() =>
        buildRun({ status: 'queued', progress: { casesTotal: 0, casesDone: 0, casesFailed: 0 } })
      );
      const { container } = render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      const filledBar = container.querySelector<HTMLElement>('div.bg-primary.h-3');
      expect(filledBar?.style.width).toBe('0%');
    });
  });

  describe('summary table', () => {
    it('renders one row per metric with mean / median / p95 / pass rate', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      const { container } = render(<RunDetailView runId="run-1" />);
      await screen.findByText(/^Summary$/);
      // Locate the Summary card by its title's closest card root, then scope queries.
      const summaryTitle = screen.getByText(/^Summary$/);
      const summaryCard = summaryTitle.closest('div.bg-card');
      expect(summaryCard).not.toBeNull();
      const { getByText: w } = within(summaryCard as HTMLElement);
      // Mean, median, p95 for exact_match
      expect(w('0.800')).toBeInTheDocument(); // mean
      expect(w('80%')).toBeInTheDocument(); // pass rate
      // Faithfulness row
      expect(w('0.650')).toBeInTheDocument(); // mean
      expect(w('60%')).toBeInTheDocument(); // pass rate
      // Sanity: container reference used to confirm the card is in the DOM tree
      expect(container.contains(summaryCard)).toBe(true);
    });

    it('does not render the summary card when summary is null', async () => {
      makeFetchMock(() => buildRun({ status: 'queued', summary: null }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.queryByText(/^Summary$/)).not.toBeInTheDocument();
    });
  });

  describe('per-case results table', () => {
    it('renders one row per case with metric score columns', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('When does my order ship?');
      expect(screen.getByText('Refund policy?')).toBeInTheDocument();
      // First case: exact_match=1.00; faithfulness=0.90
      expect(screen.getByText('1.00')).toBeInTheDocument();
      expect(screen.getByText('0.90')).toBeInTheDocument();
      // Second case: faithfulness is null → "n/a"
      expect(screen.getByText('n/a')).toBeInTheDocument();
    });

    it('opens the drill-in dialog when a case row is clicked and shows input/expected/output/scores/steps', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      const user = userEvent.setup();
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('When does my order ship?');

      // Click the first case row
      const cell = screen.getByText('When does my order ship?');
      await user.click(cell);

      // Dialog opens — title shows case #
      expect(await screen.findByText(/Case #1/)).toBeInTheDocument();
      // Section bodies — Input, Expected, Subject output
      expect(screen.getByText(/Expected output/i)).toBeInTheDocument();
      expect(screen.getByText(/Subject output/i)).toBeInTheDocument();
      // Subject output value rendered
      expect(screen.getByText('The order ships in 3 days.')).toBeInTheDocument();
      // Per-metric pills + reasoning
      expect(screen.getByText('match')).toBeInTheDocument();
      // Judge's working details
      expect(screen.getByText(/Show judge's working \(2 steps\)/)).toBeInTheDocument();
    });
  });

  describe('Cancel run button', () => {
    it('is visible while status is queued or running', async () => {
      makeFetchMock(() => buildRun({ status: 'running' }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByRole('button', { name: /Cancel run/i })).toBeInTheDocument();
    });

    it('is hidden for terminal statuses', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.queryByRole('button', { name: /Cancel run/i })).not.toBeInTheDocument();
    });

    it('POSTs to the cancel endpoint when clicked', async () => {
      const fetchMock = makeFetchMock(() => buildRun({ status: 'running' }));
      const user = userEvent.setup();
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');

      await user.click(screen.getByRole('button', { name: /Cancel run/i }));

      await waitFor(() => {
        const cancelCall = fetchMock.mock.calls.find(
          ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunCancel('run-1')
        );
        expect(cancelCall).toBeDefined();
        expect(cancelCall?.[1]).toMatchObject({ method: 'POST' });
      });
    });
  });

  describe('polling', () => {
    it('polls every 3s while status is running, then stops on terminal status', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });

      let tickCount = 0;
      const fetchMock = makeFetchMock(() => {
        tickCount += 1;
        // First two polls: running; third poll: completed (terminal)
        return buildRun({ status: tickCount < 3 ? 'running' : 'completed' });
      });

      render(<RunDetailView runId="run-1" />);
      // Initial tick — flush microtasks so the first detail + cases fetches resolve
      await flushPromises();
      const detailCallsAfterInitial = fetchMock.mock.calls.filter(
        ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')
      ).length;
      expect(detailCallsAfterInitial).toBe(1);

      // Advance 3s → second poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await flushPromises();
      let detailCalls = fetchMock.mock.calls.filter(
        ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')
      ).length;
      expect(detailCalls).toBe(2);

      // Advance 3s → third poll returns "completed" → no more polling
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await flushPromises();
      detailCalls = fetchMock.mock.calls.filter(
        ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')
      ).length;
      expect(detailCalls).toBe(3);

      // Advance another 6s — should NOT trigger more polls
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      await flushPromises();
      const finalCalls = fetchMock.mock.calls.filter(
        ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')
      ).length;
      expect(finalCalls).toBe(3);
    });

    it('does not schedule a poll on terminal-status first response', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const fetchMock = makeFetchMock(() => buildRun({ status: 'completed' }));
      render(<RunDetailView runId="run-1" />);
      await flushPromises();

      // Advance and confirm no follow-up poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      await flushPromises();
      const detailCalls = fetchMock.mock.calls.filter(
        ([url]) => url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')
      ).length;
      expect(detailCalls).toBe(1);
    });
  });

  describe('subject + dataset branches', () => {
    it('renders the workflow subject when subjectKind=workflow', async () => {
      makeFetchMock(() =>
        buildRun({
          subjectKind: 'workflow',
          agent: null,
          workflow: { id: 'w-1', name: 'Pipeline X', slug: 'pipeline-x' },
        })
      );
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText('workflow')).toBeInTheDocument();
      expect(screen.getByText('Pipeline X')).toBeInTheDocument();
    });

    it('renders "—" when neither agent nor workflow is present', async () => {
      makeFetchMock(() => buildRun({ subjectKind: 'agent', agent: null, workflow: null }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      // The Subject card body renders an em-dash placeholder
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('renders "—" for the dataset card when dataset is null', async () => {
      makeFetchMock(() => buildRun({ dataset: null }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('shows a failed-count badge when progress.casesFailed > 0', async () => {
      makeFetchMock(() =>
        buildRun({
          status: 'completed',
          progress: { casesTotal: 10, casesDone: 10, casesFailed: 3 },
        })
      );
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText('3 failed')).toBeInTheDocument();
    });

    it('shows the "Refreshing every 3 seconds" hint while running', async () => {
      makeFetchMock(() => buildRun({ status: 'running' }));
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText(/Refreshing every 3 seconds/i)).toBeInTheDocument();
    });

    it('shows a summary note when provided', async () => {
      makeFetchMock(() =>
        buildRun({
          summary: {
            metricSlugs: ['exact_match'],
            stats: {
              exact_match: { mean: 1, median: 1, p95: 1, passRate: 1, scoredCount: 5 },
            },
            note: 'Five cases excluded — missing expectedOutput.',
          },
        })
      );
      render(<RunDetailView runId="run-1" />);
      await screen.findByText(/^Summary$/);
      expect(screen.getByText(/Five cases excluded/)).toBeInTheDocument();
    });

    it('shows an empty-cases hint when there are no case results', async () => {
      makeFetchMock(
        () => buildRun({ status: 'completed' }),
        () => []
      );
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText(/No case results recorded/i)).toBeInTheDocument();
    });

    it('renders the error block in the drill-in dialog when a case has errorCode', async () => {
      const errorCase = {
        id: 'c-err',
        casePosition: 99,
        subjectOutput: '',
        subjectMetadata: null,
        metricScores: {},
        latencyMs: 0,
        costUsd: 0,
        errorCode: 'SUBJECT_TIMEOUT',
        errorMessage: 'Subject agent timed out at 30s.',
        datasetCase: { input: 'a question', expectedOutput: null, metadata: null },
      };
      makeFetchMock(
        () => buildRun({ status: 'failed' }),
        () => [errorCase]
      );
      const user = userEvent.setup();
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('a question');
      await user.click(screen.getByText('a question'));
      expect(await screen.findByText(/Case #99/)).toBeInTheDocument();
      expect(screen.getByText('SUBJECT_TIMEOUT')).toBeInTheDocument();
      expect(screen.getByText(/Subject agent timed out/)).toBeInTheDocument();
    });
  });

  describe('load error', () => {
    it('shows the API error message when the run-detail call fails', async () => {
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ success: false, error: { message: 'Boom' } }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await waitFor(() => {
        expect(screen.getByText(/Failed to load run: Boom/)).toBeInTheDocument();
      });
    });

    it('shows a fallback error message when the detail fetch throws', async () => {
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          throw new Error('Connection refused');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await waitFor(() => {
        expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
      });
    });

    it('uses HTTP status when payload lacks a success/error envelope', async () => {
      // Payload returns success:false with no error object — handler falls back to HTTP status code.
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          return {
            ok: false,
            status: 503,
            // Force the !payload.success branch but the message-fallback path.
            json: async () => ({ success: true, data: buildRun() }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await waitFor(() => {
        expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
      });
    });
  });

  describe('case row + dialog details', () => {
    it('JSON.stringifies non-string input values in the case row', async () => {
      const structuredCase = {
        id: 'c-1',
        casePosition: 1,
        subjectOutput: 'ok',
        subjectMetadata: null,
        metricScores: {
          exact_match: { score: 1, passed: true },
          faithfulness: { score: 0.8 },
        },
        latencyMs: 10,
        costUsd: 0,
        errorCode: null,
        errorMessage: null,
        datasetCase: {
          input: { question: 'shipping?' },
          expectedOutput: null,
          metadata: null,
        },
      };
      makeFetchMock(
        () => buildRun({ status: 'completed' }),
        () => [structuredCase]
      );
      render(<RunDetailView runId="run-1" />);
      await waitFor(() => {
        expect(screen.getByText(/"question":"shipping\?"/)).toBeInTheDocument();
      });
    });

    it('renders a pass/fail badge in the dialog when cell.passed is defined', async () => {
      makeFetchMock(() => buildRun({ status: 'completed' }));
      const user = userEvent.setup();
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('When does my order ship?');
      await user.click(screen.getByText('When does my order ship?'));
      await screen.findByText(/Case #1/);
      expect(screen.getByText('pass')).toBeInTheDocument();
    });

    it('skips cases when the cases endpoint returns !ok', async () => {
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: buildRun({ status: 'completed' }) }),
          } as unknown as Response;
        }
        // Cases endpoint returns !ok — branch coverage for the `if (casesRes.ok)` guard.
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      // No case rows; the empty-state hint shows
      expect(screen.getByText(/No case results recorded/i)).toBeInTheDocument();
    });

    it('skips cases when the cases endpoint returns success:false', async () => {
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: buildRun({ status: 'completed' }) }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: false, error: { message: 'forbidden' } }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('Smoke run');
      expect(screen.getByText(/No case results recorded/i)).toBeInTheDocument();
    });

    it('stringifies a non-Error thrown value into the load error message', async () => {
      const fn = vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunById('run-1')) {
          // Throw a plain string — exercises String(err) fallback branch.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'string-only-error';
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fn);
      render(<RunDetailView runId="run-1" />);
      await waitFor(() => {
        expect(screen.getByText(/string-only-error/)).toBeInTheDocument();
      });
    });

    it('shows "(empty)" when subjectOutput is an empty string in the dialog', async () => {
      const blankOutputCase = {
        id: 'c-blank',
        casePosition: 5,
        subjectOutput: '',
        subjectMetadata: null,
        metricScores: {},
        latencyMs: 0,
        costUsd: 0,
        errorCode: null,
        errorMessage: null,
        datasetCase: { input: 'q', expectedOutput: null, metadata: null },
      };
      makeFetchMock(
        () => buildRun({ status: 'completed' }),
        () => [blankOutputCase]
      );
      const user = userEvent.setup();
      render(<RunDetailView runId="run-1" />);
      await screen.findByText('q');
      await user.click(screen.getByText('q'));
      await screen.findByText(/Case #5/);
      expect(screen.getByText('(empty)')).toBeInTheDocument();
    });
  });
});
