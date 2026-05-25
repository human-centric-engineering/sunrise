/**
 * RunsTable Component Tests
 *
 * Test coverage:
 * - One row per run; name links to detail page
 * - Status badge applies per-status styling (queued/running/completed/failed/cancelled)
 * - Progress percent calculation handles 0/null total gracefully
 * - Cost is formatted to $0.0000
 * - Subject column shows agent OR workflow OR "—"
 * - "New run" CTA links to /runs/new
 *
 * @see components/admin/orchestration/evaluations-foundations/runs-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import {
  RunsTable,
  type RunListItem,
} from '@/components/admin/orchestration/evaluations-foundations/runs-table';

function buildRun(overrides: Partial<RunListItem> = {}): RunListItem {
  return {
    id: 'run-1',
    name: 'Support agent v3',
    subjectKind: 'agent',
    status: 'running',
    agent: { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
    workflow: null,
    dataset: { id: 'ds-1', name: 'FAQ', caseCount: 10 },
    progress: { casesTotal: 10, casesDone: 5, casesFailed: 0 },
    totalCostUsd: 0.1234,
    updatedAt: '2026-05-10T10:00:00Z',
    ...overrides,
  };
}

describe('RunsTable', () => {
  it('renders one row per run', () => {
    const runs = [buildRun({ id: 'r-1' }), buildRun({ id: 'r-2', name: 'Other run' })];
    render(<RunsTable runs={runs} />);
    expect(screen.getAllByRole('row')).toHaveLength(runs.length + 1); // +1 header
  });

  it('renders the run name as a link to its detail page', () => {
    render(<RunsTable runs={[buildRun()]} />);
    const link = screen.getByRole('link', { name: 'Support agent v3' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/evaluations/runs/run-1');
  });

  describe('status badges', () => {
    const statuses: Array<{ status: RunListItem['status']; className: string }> = [
      { status: 'queued', className: 'bg-slate-100' },
      { status: 'running', className: 'bg-blue-100' },
      { status: 'completed', className: 'bg-green-100' },
      { status: 'failed', className: 'bg-red-100' },
      { status: 'cancelled', className: 'bg-amber-100' },
    ];

    for (const { status, className } of statuses) {
      it(`renders the ${status} status badge with the matching style class`, () => {
        render(<RunsTable runs={[buildRun({ status })]} />);
        const badge = screen.getByText(status);
        expect(badge).toBeInTheDocument();
        expect(badge.className).toContain(className);
      });
    }
  });

  describe('progress percent', () => {
    it('computes the percent when progress is provided', () => {
      render(
        <RunsTable
          runs={[buildRun({ progress: { casesTotal: 10, casesDone: 7, casesFailed: 0 } })]}
        />
      );
      expect(screen.getByText('70% (7/10)')).toBeInTheDocument();
    });

    it('shows "—" when casesTotal is 0', () => {
      render(
        <RunsTable
          runs={[buildRun({ progress: { casesTotal: 0, casesDone: 0, casesFailed: 0 } })]}
        />
      );
      // First cell containing "—" is the progress one
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('shows "—" when progress is null', () => {
      render(<RunsTable runs={[buildRun({ progress: null })]} />);
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  describe('cost formatting', () => {
    it('formats cost to 4 decimal places with a leading $', () => {
      render(<RunsTable runs={[buildRun({ totalCostUsd: 0.1 })]} />);
      expect(screen.getByText('$0.1000')).toBeInTheDocument();
    });

    it('shows "—" when totalCostUsd is null', () => {
      render(<RunsTable runs={[buildRun({ totalCostUsd: null })]} />);
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  describe('subject column', () => {
    it('shows the agent badge + name when subjectKind=agent with an agent', () => {
      render(
        <RunsTable
          runs={[
            buildRun({
              subjectKind: 'agent',
              agent: { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
              workflow: null,
            }),
          ]}
        />
      );
      expect(screen.getByText('agent')).toBeInTheDocument();
      expect(screen.getByText(/Bot Alpha/)).toBeInTheDocument();
    });

    it('shows the workflow badge + name when subjectKind=workflow with a workflow', () => {
      render(
        <RunsTable
          runs={[
            buildRun({
              subjectKind: 'workflow',
              agent: null,
              workflow: { id: 'w-1', name: 'Pipeline X', slug: 'pipeline-x' },
            }),
          ]}
        />
      );
      expect(screen.getByText('workflow')).toBeInTheDocument();
      expect(screen.getByText(/Pipeline X/)).toBeInTheDocument();
    });

    it('shows "—" when there is no agent or workflow', () => {
      const run = buildRun({ agent: null, workflow: null, subjectKind: 'agent' });
      render(<RunsTable runs={[run]} />);
      const row = screen.getByRole('link', { name: 'Support agent v3' }).closest('tr');
      expect(row).not.toBeNull();
      // Subject cell is the 2nd cell — but multiple "—" can exist; assert at least one
      expect(within(row as HTMLElement).getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  it('renders the dataset name when present', () => {
    render(<RunsTable runs={[buildRun()]} />);
    expect(screen.getByText('FAQ')).toBeInTheDocument();
  });

  it('shows "—" when dataset is null', () => {
    render(<RunsTable runs={[buildRun({ dataset: null })]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the "New run" CTA linking to /runs/new', () => {
    render(<RunsTable runs={[]} />);
    const cta = screen.getByRole('link', { name: /new run/i });
    expect(cta).toHaveAttribute('href', '/admin/orchestration/evaluations/runs/new');
  });

  it('shows the total count next to the heading', () => {
    const runs = [buildRun({ id: 'a' }), buildRun({ id: 'b' }), buildRun({ id: 'c' })];
    render(<RunsTable runs={runs} />);
    expect(screen.getByText('3 total')).toBeInTheDocument();
  });

  it('formats updatedAt with en-GB short locale', () => {
    render(<RunsTable runs={[buildRun({ updatedAt: '2026-05-10T10:00:00Z' })]} />);
    expect(screen.getByText('10 May 2026')).toBeInTheDocument();
  });
});
