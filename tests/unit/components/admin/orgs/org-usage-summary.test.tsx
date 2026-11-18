// @vitest-environment happy-dom

/**
 * OrgUsageSummary Component Tests (§110 t-790)
 *
 * Test Coverage:
 * - Spend, calls and tokens for the period
 * - Usage against the cap as a utilisation bar
 * - "No cap set" and no bar without a cap; "Paid calls off" and no bar at a cap of 0
 *
 * @see components/admin/orgs/org-usage-summary.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OrgUsageSummary } from '@/components/admin/orgs/org-usage-summary';
import type { OrgUsageRow } from '@/lib/orchestration/llm/cost-reports';

function makeRow(overrides: Partial<OrgUsageRow> = {}): OrgUsageRow {
  return {
    orgId: 'org-acme',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    totalCostUsd: 80,
    ownKeyCostUsd: 0,
    inputTokens: 9000,
    outputTokens: 1000,
    count: 1234,
    monthlyBudgetUsd: 100,
    utilisation: 0.8,
    ...overrides,
  };
}

describe('OrgUsageSummary', () => {
  it('shows spend, calls and tokens for the period, and usage against the cap', () => {
    render(<OrgUsageSummary period="2026-10" row={makeRow()} />);

    expect(screen.getByText('Spend (2026-10)')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
  });

  it("shows the platform's spend, with the org's own-key spend apart, only when it has some (§137)", () => {
    const { rerender } = render(<OrgUsageSummary period="2026-10" row={makeRow()} />);
    expect(screen.queryByTestId('org-usage-own-key')).not.toBeInTheDocument();

    rerender(
      <OrgUsageSummary period="2026-10" row={makeRow({ totalCostUsd: 80, ownKeyCostUsd: 30 })} />
    );

    expect(screen.getByText('$50.00')).toBeInTheDocument(); // 80 − 30
    expect(screen.queryByText('$80.00')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-usage-own-key')).toHaveTextContent(
      'Plus $30.00 on its own AI keys'
    );
  });

  it('says there is no cap, and shows no bar, when the org has none', () => {
    render(
      <OrgUsageSummary
        period="2026-10"
        row={makeRow({ monthlyBudgetUsd: null, utilisation: null })}
      />
    );

    expect(screen.getByText('No cap set')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows no bar at a cap of 0, which turns paid calls off', () => {
    render(
      <OrgUsageSummary period="2026-10" row={makeRow({ monthlyBudgetUsd: 0, utilisation: null })} />
    );

    expect(screen.queryByText('No cap set')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('No budget set')).not.toBeInTheDocument();
    expect(screen.getByText('Paid calls off')).toBeInTheDocument();
  });
});
