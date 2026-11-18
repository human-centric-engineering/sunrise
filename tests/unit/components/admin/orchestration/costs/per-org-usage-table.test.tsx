// @vitest-environment happy-dom

/**
 * PerOrgUsageTable Component Tests (§110 t-790)
 *
 * Test Coverage:
 * - One row per org with spend, calls, tokens and cap; the name links to the org page
 * - Utilisation against the cap; "No budget set" without one; "Paid calls off" at a cap of 0
 * - A suspended org is badged
 * - The detached ("No org") row appears only when there is detached spend
 *
 * @see components/admin/orchestration/costs/per-org-usage-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { PerOrgUsageTable } from '@/components/admin/orchestration/costs/per-org-usage-table';
import type { OrgUsageReport, OrgUsageRow } from '@/lib/orchestration/llm/cost-reports';

function makeRow(overrides: Partial<OrgUsageRow> = {}): OrgUsageRow {
  return {
    orgId: 'org-acme',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    totalCostUsd: 25,
    ownKeyCostUsd: 0,
    inputTokens: 1200,
    outputTokens: 300,
    count: 42,
    monthlyBudgetUsd: 100,
    utilisation: 0.25,
    ...overrides,
  };
}

function makeReport(overrides: Partial<OrgUsageReport> = {}): OrgUsageReport {
  return {
    period: '2026-10',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    orgs: [makeRow()],
    detached: null,
    totals: { totalCostUsd: 25, ownKeyCostUsd: 0, inputTokens: 1200, outputTokens: 300, count: 42 },
    ...overrides,
  };
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('link', { name }).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('PerOrgUsageTable', () => {
  it("shows each org's spend, calls, tokens and cap, linking to the org", () => {
    render(<PerOrgUsageTable report={makeReport()} />);

    expect(screen.getByText(/Spend by organisation \(2026-10\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute(
      'href',
      '/admin/orgs/org-acme'
    );
    const row = within(rowFor('Acme'));
    expect(row.getByText('42')).toBeInTheDocument();
    expect(row.getByText('1,500')).toBeInTheDocument(); // 1200 in + 300 out
    expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('says when an org has no cap, and when its cap of 0 turns paid calls off', () => {
    render(
      <PerOrgUsageTable
        report={makeReport({
          orgs: [
            makeRow({ orgId: 'a', name: 'Uncapped', monthlyBudgetUsd: null, utilisation: null }),
            makeRow({ orgId: 'b', name: 'Zeroed', monthlyBudgetUsd: 0, utilisation: null }),
          ],
        })}
      />
    );

    expect(within(rowFor('Uncapped')).getByText('No budget set')).toBeInTheDocument();
    expect(within(rowFor('Zeroed')).getByText('Paid calls off')).toBeInTheDocument();
    expect(within(rowFor('Zeroed')).queryByText('No budget set')).not.toBeInTheDocument();
  });

  it("shows an org's own-key spend in its own column, and only the platform's under Spend (§137)", () => {
    const { rerender } = render(<PerOrgUsageTable report={makeReport()} />);
    // No org has any: no column.
    expect(screen.queryByText('Own keys')).not.toBeInTheDocument();

    rerender(
      <PerOrgUsageTable
        report={makeReport({
          orgs: [makeRow({ totalCostUsd: 25, ownKeyCostUsd: 18.5 })],
          totals: {
            totalCostUsd: 25,
            ownKeyCostUsd: 18.5,
            inputTokens: 1200,
            outputTokens: 300,
            count: 42,
          },
        })}
      />
    );

    expect(screen.getByText('Own keys')).toBeInTheDocument();
    const row = within(rowFor('Acme'));
    expect(row.getByText('$6.50')).toBeInTheDocument(); // 25 − 18.50: the platform's
    expect(row.getByText('$18.50')).toBeInTheDocument();
    expect(row.queryByText('$25.00')).not.toBeInTheDocument();
  });

  it('badges a suspended org', () => {
    render(<PerOrgUsageTable report={makeReport({ orgs: [makeRow({ status: 'SUSPENDED' })] })} />);
    expect(within(rowFor('Acme')).getByText('suspended')).toBeInTheDocument();
  });

  it('shows the detached row when there is detached spend', () => {
    render(
      <PerOrgUsageTable
        report={makeReport({
          detached: {
            totalCostUsd: 7,
            ownKeyCostUsd: 0,
            inputTokens: 50,
            outputTokens: 5,
            count: 3,
          },
        })}
      />
    );

    const detached = within(screen.getByTestId('per-org-usage-detached'));
    expect(detached.getByText('No org')).toBeInTheDocument();
    expect(detached.getByText('3')).toBeInTheDocument();
    expect(detached.getByText('55')).toBeInTheDocument();
  });

  it('leaves the detached row out when there is none, or it is empty', () => {
    const { rerender } = render(<PerOrgUsageTable report={makeReport({ detached: null })} />);
    expect(screen.queryByTestId('per-org-usage-detached')).not.toBeInTheDocument();

    rerender(
      <PerOrgUsageTable
        report={makeReport({
          detached: {
            totalCostUsd: 0,
            ownKeyCostUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            count: 0,
          },
        })}
      />
    );
    expect(screen.queryByTestId('per-org-usage-detached')).not.toBeInTheDocument();
  });
});
