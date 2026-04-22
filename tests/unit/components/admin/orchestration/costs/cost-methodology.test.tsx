/**
 * CostMethodology Component Tests
 *
 * @see components/admin/orchestration/costs/cost-methodology.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CostMethodology } from '@/components/admin/orchestration/costs/cost-methodology';

describe('CostMethodology', () => {
  it('renders with test id', () => {
    render(<CostMethodology />);
    expect(screen.getByTestId('cost-methodology')).toBeInTheDocument();
  });

  it('renders the title', () => {
    render(<CostMethodology />);
    expect(screen.getByText('How costs are calculated')).toBeInTheDocument();
  });

  it('shows "Measured (exact)" section', () => {
    render(<CostMethodology />);
    expect(screen.getByText('Measured (exact)')).toBeInTheDocument();
    expect(screen.getByText(/Token counts.*reported by the LLM provider/i)).toBeInTheDocument();
  });

  it('shows "Estimated (close approximation)" section', () => {
    render(<CostMethodology />);
    expect(screen.getByText('Estimated (close approximation)')).toBeInTheDocument();
    expect(
      screen.getByText(/Per-token rates.*from OpenRouter.*refreshed every 24h/i)
    ).toBeInTheDocument();
  });

  it('shows tokenomics section', () => {
    render(<CostMethodology />);
    expect(screen.getByText('Tokenomics: understanding LLM pricing')).toBeInTheDocument();
    expect(screen.getByText(/Prices are falling fast/)).toBeInTheDocument();
    expect(screen.getByText(/Output is the expensive part/)).toBeInTheDocument();
  });

  it('shows quick cost guide table', () => {
    render(<CostMethodology />);
    expect(screen.getByText('Quick cost guide by use case')).toBeInTheDocument();
    expect(screen.getByText('Simple classification / routing')).toBeInTheDocument();
    expect(screen.getByText('Multi-step reasoning / tool loops')).toBeInTheDocument();
  });

  it('shows workflow cost estimation section', () => {
    render(<CostMethodology />);
    expect(screen.getByText('Estimating workflow costs')).toBeInTheDocument();
    expect(screen.getByText('Simple workflow (2–3 LLM steps)')).toBeInTheDocument();
    expect(screen.getByText('Complex workflow (5–8 LLM steps)')).toBeInTheDocument();
  });

  it('mentions provider invoice reconciliation', () => {
    render(<CostMethodology />);
    expect(screen.getByText(/actual provider invoice may differ slightly/i)).toBeInTheDocument();
  });
});
