/**
 * EvaluationMetricChips component tests.
 *
 * Covers:
 *  - renders three chips (F, G, R) with formatted scores
 *  - null score renders as "n/a"
 *  - clicking a chip opens a popover with the judge's reasoning
 *  - missing reasoning shows the "No reasoning recorded." placeholder
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationMetricChips } from '@/components/admin/orchestration/evaluation-metric-chips';

describe('EvaluationMetricChips', () => {
  it('renders three chips with formatted scores to two decimal places', () => {
    render(
      <EvaluationMetricChips
        faithfulnessScore={0.92}
        groundednessScore={0.85}
        relevanceScore={0.95}
      />
    );

    expect(screen.getByLabelText('Faithfulness score: 0.92')).toBeInTheDocument();
    expect(screen.getByLabelText('Groundedness score: 0.85')).toBeInTheDocument();
    expect(screen.getByLabelText('Relevance score: 0.95')).toBeInTheDocument();
  });

  it('renders null score as "n/a"', () => {
    render(
      <EvaluationMetricChips
        faithfulnessScore={null}
        groundednessScore={0.7}
        relevanceScore={0.9}
      />
    );

    expect(screen.getByLabelText('Faithfulness score: n/a')).toBeInTheDocument();
  });

  it('opens a popover with the judge reasoning when a chip is clicked', async () => {
    const user = userEvent.setup();
    render(
      <EvaluationMetricChips
        faithfulnessScore={0.9}
        groundednessScore={0.8}
        relevanceScore={0.95}
        reasoning={{
          faithfulness: 'All marked claims map to the cited excerpts.',
          groundedness: 'Most claims are traceable.',
          relevance: 'Direct answer.',
        }}
      />
    );

    await user.click(screen.getByLabelText('Faithfulness score: 0.90'));
    expect(
      await screen.findByText('All marked claims map to the cited excerpts.')
    ).toBeInTheDocument();
  });

  it('shows the placeholder when reasoning is missing', async () => {
    const user = userEvent.setup();
    render(
      <EvaluationMetricChips faithfulnessScore={0.5} groundednessScore={0.6} relevanceScore={0.7} />
    );

    await user.click(screen.getByLabelText('Faithfulness score: 0.50'));
    expect(await screen.findByText('No reasoning recorded.')).toBeInTheDocument();
  });
});
