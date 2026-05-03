/**
 * EvaluationTrendChart component tests.
 *
 * Covers:
 *  - returns null when fewer than 2 points (not enough for a trend)
 *  - renders the card with the title and data caption when ≥2 points exist
 *
 * Recharts is heavy and renders to SVG; we just assert the wrapper card
 * + title render. Visual regression is out of scope for unit tests.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  EvaluationTrendChart,
  type EvaluationTrendPoint,
} from '@/components/admin/orchestration/evaluation-trend-chart';

const POINT_A: EvaluationTrendPoint = {
  sessionId: 'sess-a',
  title: 'Eval A',
  completedAt: '2026-04-01T10:00:00Z',
  avgFaithfulness: 0.9,
  avgGroundedness: 0.85,
  avgRelevance: 0.95,
  scoredLogCount: 5,
};

const POINT_B: EvaluationTrendPoint = {
  sessionId: 'sess-b',
  title: 'Eval B',
  completedAt: '2026-04-15T10:00:00Z',
  avgFaithfulness: 0.92,
  avgGroundedness: 0.88,
  avgRelevance: 0.96,
  scoredLogCount: 8,
};

describe('EvaluationTrendChart', () => {
  it('renders nothing when fewer than 2 points are supplied', () => {
    const { container } = render(<EvaluationTrendChart points={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when only one point is supplied', () => {
    const { container } = render(<EvaluationTrendChart points={[POINT_A]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the card with title and noisy-scores caption when ≥2 points exist', () => {
    render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);
    expect(screen.getByText('Evaluation quality over time')).toBeInTheDocument();
    expect(screen.getByText(/noisy below ~20 messages/i)).toBeInTheDocument();
  });

  it('respects a custom title prop', () => {
    render(<EvaluationTrendChart points={[POINT_A, POINT_B]} title="Custom Title" />);
    expect(screen.getByText('Custom Title')).toBeInTheDocument();
  });
});
