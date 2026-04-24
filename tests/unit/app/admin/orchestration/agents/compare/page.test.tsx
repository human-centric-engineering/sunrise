/**
 * Unit Tests: CompareAgentsPage
 *
 * Test Coverage:
 * - Metadata: title and description
 * - Missing params: renders error state with agents-list link when a or b absent
 * - Both params present: renders AgentComparisonView with correct agentIdA / agentIdB
 * - Breadcrumb nav: rendered in both error and success states
 *
 * @see app/admin/orchestration/agents/compare/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Stub AgentComparisonView so we can inspect its props without a real network.
vi.mock('@/components/admin/orchestration/agent-comparison-view', () => ({
  AgentComparisonView: (props: { agentIdA: string; agentIdB: string }) => (
    <div
      data-testid="agent-comparison-view"
      data-agent-id-a={props.agentIdA}
      data-agent-id-b={props.agentIdB}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import CompareAgentsPage, { metadata } from '@/app/admin/orchestration/agents/compare/page';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSearchParams(params: { a?: string; b?: string }) {
  return Promise.resolve(params);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CompareAgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Metadata ───────────────────────────────────────────────────────────────

  it('exports the correct page title', () => {
    expect(metadata.title).toBe('Compare Agents · AI Orchestration');
  });

  it('exports the correct page description', () => {
    expect(metadata.description).toBe('Side-by-side performance comparison of two AI agents.');
  });

  // ── Missing params — error state ──────────────────────────────────────────

  it('renders the error message when both params are missing', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({}) }));

    expect(screen.getByText(/select exactly two agents/i)).toBeInTheDocument();
  });

  it('renders the error message when only "a" is provided', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({ a: 'agent-abc' }) }));

    expect(screen.getByText(/select exactly two agents/i)).toBeInTheDocument();
  });

  it('renders the error message when only "b" is provided', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({ b: 'agent-xyz' }) }));

    expect(screen.getByText(/select exactly two agents/i)).toBeInTheDocument();
  });

  it('links back to the agents list in the error state', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({}) }));

    const agentsLinks = screen
      .getAllByRole('link')
      .filter((el) => el.getAttribute('href') === '/admin/orchestration/agents');
    expect(agentsLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render AgentComparisonView in the error state', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({}) }));

    expect(screen.queryByTestId('agent-comparison-view')).toBeNull();
  });

  // ── Both params present — success state ───────────────────────────────────

  it('renders AgentComparisonView when both a and b are provided', async () => {
    render(
      await CompareAgentsPage({
        searchParams: makeSearchParams({ a: 'agent-aaa', b: 'agent-bbb' }),
      })
    );

    expect(screen.getByTestId('agent-comparison-view')).toBeInTheDocument();
  });

  it('passes agentIdA from the "a" search param', async () => {
    render(
      await CompareAgentsPage({
        searchParams: makeSearchParams({ a: 'agent-aaa', b: 'agent-bbb' }),
      })
    );

    expect(screen.getByTestId('agent-comparison-view')).toHaveAttribute(
      'data-agent-id-a',
      'agent-aaa'
    );
  });

  it('passes agentIdB from the "b" search param', async () => {
    render(
      await CompareAgentsPage({
        searchParams: makeSearchParams({ a: 'agent-aaa', b: 'agent-bbb' }),
      })
    );

    expect(screen.getByTestId('agent-comparison-view')).toHaveAttribute(
      'data-agent-id-b',
      'agent-bbb'
    );
  });

  // ── Breadcrumb nav ────────────────────────────────────────────────────────

  it('renders the breadcrumb nav in the error state', async () => {
    render(await CompareAgentsPage({ searchParams: makeSearchParams({}) }));

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI Orchestration' })).toBeInTheDocument();
  });

  it('renders the breadcrumb nav in the success state', async () => {
    render(
      await CompareAgentsPage({
        searchParams: makeSearchParams({ a: 'agent-aaa', b: 'agent-bbb' }),
      })
    );

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agents' })).toBeInTheDocument();
  });

  it('renders the Compare Agents heading in the success state', async () => {
    render(
      await CompareAgentsPage({
        searchParams: makeSearchParams({ a: 'agent-aaa', b: 'agent-bbb' }),
      })
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Compare Agents' })).toBeInTheDocument();
  });
});
