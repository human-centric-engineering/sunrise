/**
 * PricingReference Component Tests
 *
 * @see components/admin/orchestration/costs/pricing-reference.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PricingReference } from '@/components/admin/orchestration/costs/pricing-reference';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 15,
    outputCostPerMillion: 75,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'local:generic',
    name: 'Local Model (generic)',
    provider: 'local',
    tier: 'local',
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    maxContext: 8_192,
    supportsTools: false,
  },
];

describe('PricingReference', () => {
  it('renders the card with test id', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={null} />);
    expect(screen.getByTestId('pricing-reference')).toBeInTheDocument();
  });

  it('shows "Static fallback" badge when fetchedAt is 0', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={0} />);
    expect(screen.getByText('Static fallback')).toBeInTheDocument();
  });

  it('shows "Live pricing" badge when fetchedAt is recent', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now() - 60_000} />);
    expect(screen.getByText('Live pricing')).toBeInTheDocument();
  });

  it('shows "Never (using static fallback)" for last synced when fetchedAt is 0', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={0} />);
    expect(screen.getByText('Never (using static fallback)')).toBeInTheDocument();
  });

  it('shows relative time for last synced when fetchedAt is recent', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now() - 2 * 60 * 60 * 1000} />);
    expect(screen.getByText('2h ago')).toBeInTheDocument();
  });

  it('starts collapsed — no table visible', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now()} />);
    expect(screen.queryByText('Input rate')).not.toBeInTheDocument();
  });

  it('expands on click to show pricing table', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now()} />);
    fireEvent.click(screen.getByText('Model pricing reference'));
    expect(screen.getByText('Input rate')).toBeInTheDocument();
    expect(screen.getByText('Output rate')).toBeInTheDocument();
  });

  it('shows model names and rates when expanded', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now()} />);
    fireEvent.click(screen.getByText('Model pricing reference'));
    expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument();
    expect(screen.getByText('Claude Haiku 4.5')).toBeInTheDocument();
    // Rates may appear multiple times (input + output columns) — use getAllByText
    expect(screen.getAllByText('$15/M').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$75/M').length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Free" for local model rates', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now()} />);
    fireEvent.click(screen.getByText('Model pricing reference'));
    const freeLabels = screen.getAllByText('Free');
    expect(freeLabels.length).toBeGreaterThanOrEqual(2); // input + output
  });

  it('renders empty state when models is null', () => {
    render(<PricingReference models={null} fetchedAt={null} />);
    fireEvent.click(screen.getByText('Model pricing reference'));
    expect(screen.getByText('No models in registry.')).toBeInTheDocument();
  });

  it('shows source badge for each model row', () => {
    render(<PricingReference models={MOCK_MODELS} fetchedAt={Date.now()} />);
    fireEvent.click(screen.getByText('Model pricing reference'));
    const liveBadges = screen.getAllByText('Live');
    // Title badge + one per model row
    expect(liveBadges.length).toBeGreaterThanOrEqual(MOCK_MODELS.length);
  });
});
