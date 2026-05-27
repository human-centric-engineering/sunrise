/**
 * PairwiseVerdictCard smoke tests.
 *
 * Focused on the load-bearing client behaviours:
 *   - Empty state copy depends on which gate trips: dataset missing,
 *     <2 completed variants, over 100-case cap, or just "no verdict yet".
 *   - Verdict-display renders A/B/tie counts + judge slug + computedAt.
 *   - The "Run verdict" button is disabled when any gate trips OR the
 *     judge list is empty.
 *   - Submitting POSTs to /experiments/:id/verdicts with the chosen
 *     judge + variant pair and refreshes the router on success.
 *   - API errors surface in the dialog's error pane.
 *
 * @see components/admin/orchestration/experiments/pairwise-verdict-card.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import {
  PairwiseVerdictCard,
  type JudgeOption,
  type VariantOption,
} from '@/components/admin/orchestration/experiments/pairwise-verdict-card';
import type { PairwiseVerdictSummary } from '@/types/orchestration';

const EXPERIMENT_ID = 'exp-1';

const judges: JudgeOption[] = [
  { slug: 'eval-judge-correctness', name: 'Correctness Judge' },
  { slug: 'eval-judge-relevance', name: 'Relevance Judge' },
];

function variant(
  variantId: string,
  label: string,
  runStatus: string | null = 'completed'
): VariantOption {
  return {
    variantId,
    label,
    evaluationRunId: runStatus ? `run-${variantId}` : null,
    runStatus,
  };
}

function completedVariants(): VariantOption[] {
  return [variant('a', 'Control'), variant('b', 'New prompt')];
}

function fullVerdict(): PairwiseVerdictSummary {
  return {
    judgeAgentSlug: 'eval-judge-correctness',
    variantAId: 'a',
    variantBId: 'b',
    computedAt: '2026-05-27T10:00:00.000Z',
    casesScored: 8,
    casesFailed: 0,
    counts: { A: 5, B: 2, tie: 1 },
    perCase: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PairwiseVerdictCard — empty state messaging', () => {
  it('explains the "still queued" gate when fewer than 2 variants are completed', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={[variant('a', 'Control'), variant('b', 'Still queued', 'queued')]}
        caseCount={5}
      />
    );
    expect(screen.getByText(/Both variants need a completed evaluation run/i)).toBeInTheDocument();
  });

  it('explains the missing-dataset gate when caseCount is null', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={null}
      />
    );
    expect(screen.getByText(/has no dataset/i)).toBeInTheDocument();
  });

  it('explains the 100-case cap when the dataset is too large', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={250}
      />
    );
    expect(screen.getByText(/cap at 100 cases.*has 250/i)).toBeInTheDocument();
  });

  it('shows the default "no verdict yet" copy when all gates pass', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByText(/No verdict yet/i)).toBeInTheDocument();
  });
});

describe('PairwiseVerdictCard — verdict display', () => {
  it('renders A/B/tie counts plus judge slug and timestamp', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={fullVerdict()}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByText(/Control wins: 5/i)).toBeInTheDocument();
    expect(screen.getByText(/New prompt wins: 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Ties: 1/i)).toBeInTheDocument();
    expect(screen.getByText('eval-judge-correctness')).toBeInTheDocument();
    expect(screen.getByText(/8 cases scored/i)).toBeInTheDocument();
  });

  it('renders a "Failed" badge when casesFailed > 0', () => {
    const verdict = { ...fullVerdict(), casesFailed: 3 };
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={verdict}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByText(/Failed: 3/i)).toBeInTheDocument();
  });

  it('shows "Re-run verdict" on the button when a verdict already exists', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={fullVerdict()}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByRole('button', { name: /Re-run verdict/i })).toBeInTheDocument();
  });
});

describe('PairwiseVerdictCard — button disabled states', () => {
  it('disables the button when no completed-variant pair exists', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={[variant('a', 'Control'), variant('b', 'Queued', 'queued')]}
        caseCount={5}
      />
    );
    expect(screen.getByRole('button', { name: /Run verdict/i })).toBeDisabled();
  });

  it('disables the button when over the case cap', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={500}
      />
    );
    expect(screen.getByRole('button', { name: /Run verdict/i })).toBeDisabled();
  });

  it('disables the button when no dataset is attached', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={null}
      />
    );
    expect(screen.getByRole('button', { name: /Run verdict/i })).toBeDisabled();
  });

  it('disables the button when the judges list is empty', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={[]}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByRole('button', { name: /Run verdict/i })).toBeDisabled();
  });

  it('enables the button when every gate passes', () => {
    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );
    expect(screen.getByRole('button', { name: /Run verdict/i })).not.toBeDisabled();
  });
});

describe('PairwiseVerdictCard — submit flow', () => {
  it('POSTs the chosen judge + variant pair and refreshes the router on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: fullVerdict() }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Run verdict/i }));
    // The dialog's submit button is the second "Run verdict" in the tree.
    const buttons = screen.getAllByRole('button', { name: /Run verdict/i });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/admin/orchestration/experiments/${EXPERIMENT_ID}/verdicts`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.judgeAgentSlug).toBe('eval-judge-correctness');
    expect(body.variantAId).toBe('a');
    expect(body.variantBId).toBe('b');

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledOnce());
  });

  it('surfaces the API error message when the POST fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: { message: 'Pairwise verdicts cap at 100 cases — this dataset has 250.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PairwiseVerdictCard
        experimentId={EXPERIMENT_ID}
        verdict={null}
        judges={judges}
        variants={completedVariants()}
        caseCount={10}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Run verdict/i }));
    const buttons = screen.getAllByRole('button', { name: /Run verdict/i });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(screen.getByText(/cap at 100 cases.*has 250/i)).toBeInTheDocument());
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
