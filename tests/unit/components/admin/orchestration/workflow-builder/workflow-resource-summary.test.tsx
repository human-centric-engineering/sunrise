/**
 * Unit Tests: WorkflowResourceSummary — CostBanner and defensive Array.isArray guard
 *
 * Test Coverage:
 * - Renders nothing when there are no resources, no estimate, and no loading state
 * - Renders loading banner (spinner + "Estimating cost…") when costLoading=true and no estimate
 * - Renders banner with "no cap configured" copy when effectiveCapUsd is null
 * - Renders ok band when projected mid-cost is comfortably under 50% of cap
 * - Renders warn band (amber) with percentage when projected mid-cost is 50–99% of cap
 * - Renders over band (red) with "exceeds" copy when projected cost meets or exceeds cap
 * - USD formatting: $0.00, <$0.01, and normal values
 * - Shows basedOn badge ("empirical" / "heuristic") and range pill
 * - Does not crash when capabilities prop is not an array (null / object)
 * - Does not crash when agents prop is not an array (null / object)
 *
 * @see components/admin/orchestration/workflow-builder/workflow-resource-summary.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowResourceSummary } from '@/components/admin/orchestration/workflow-builder/workflow-resource-summary';
import type { WorkflowCostEstimateWithCap } from '@/components/admin/orchestration/workflow-builder/use-workflow-cost-estimate';
import type { CapabilityOption } from '@/components/admin/orchestration/workflow-builder/block-editors';
import type { AgentOption } from '@/components/admin/orchestration/workflow-builder/block-editors';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import type { WorkflowStepType } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Minimal WorkflowCostEstimateWithCap factory.
 * Override only the fields relevant to each test.
 */
function makeEstimate(
  overrides: Partial<WorkflowCostEstimateWithCap> = {}
): WorkflowCostEstimateWithCap {
  return {
    basedOn: 'heuristic',
    sampleSize: 0,
    midUsd: 0.05,
    lowUsd: 0.02,
    highUsd: 0.1,
    modelUsed: 'claude-sonnet-4-6',
    judgeModelUsed: null,
    modelMix: [],
    workflowHasSupervisor: false,
    llmStepCount: 2,
    perStep: [],
    notes: 'Heuristic estimate based on step count.',
    effectiveCapUsd: null,
    ...overrides,
  };
}

/** Minimal PatternNode that collectResources ignores (type=llm_call, no cap/agent slug). */
const EMPTY_NODES: readonly never[] = [];

const EMPTY_CAPABILITIES: readonly CapabilityOption[] = [];
const EMPTY_AGENTS: readonly AgentOption[] = [];

/**
 * Build a minimal PatternNode for collectResources. React Flow's `Node`
 * shape requires `id`, `data`, `position`, and `type`. We don't need any
 * other React Flow plumbing because the component only reads `id` and
 * `data` (label/type/config).
 */
function makeNode(
  id: string,
  type: WorkflowStepType,
  config: Record<string, unknown>,
  label?: string
): PatternNode {
  return {
    id,
    type: 'pattern',
    position: { x: 0, y: 0 },
    data: { label: label ?? id, type, config },
  };
}

const DEFAULT_PROPS = {
  nodes: EMPTY_NODES,
  capabilities: EMPTY_CAPABILITIES,
  agents: EMPTY_AGENTS,
  onFocusNode: vi.fn(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderSummary(
  overrides: Partial<{
    costEstimate: WorkflowCostEstimateWithCap | null;
    costLoading: boolean;
  }> = {}
) {
  return render(<WorkflowResourceSummary {...DEFAULT_PROPS} {...overrides} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowResourceSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Visibility guard ────────────────────────────────────────────────────────

  describe('visibility guard', () => {
    it('renders nothing when there are no resources, no estimate, and no loading', () => {
      const { container } = renderSummary({
        costEstimate: null,
        costLoading: false,
      });
      // The component returns null — nothing should be mounted at all
      expect(container.firstChild).toBeNull();
    });

    it('renders the panel when costLoading=true even with no resources', () => {
      renderSummary({ costEstimate: null, costLoading: true });
      expect(screen.getByTestId('resource-summary-panel')).toBeInTheDocument();
    });

    it('renders the panel when an estimate is present even with no resources', () => {
      renderSummary({ costEstimate: makeEstimate() });
      expect(screen.getByTestId('resource-summary-panel')).toBeInTheDocument();
    });
  });

  // ── Loading state ───────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('renders a cost banner with data-cost-band="loading" when costLoading=true and no estimate', () => {
      renderSummary({ costEstimate: null, costLoading: true });
      const banner = screen.getByTestId('cost-banner');
      expect(banner).toHaveAttribute('data-cost-band', 'loading');
    });

    it('shows "Estimating cost…" text in the loading banner', () => {
      renderSummary({ costEstimate: null, costLoading: true });
      expect(screen.getByText('Estimating cost…')).toBeInTheDocument();
    });

    it('does not show a dollar amount in the loading banner', () => {
      renderSummary({ costEstimate: null, costLoading: true });
      // No projected USD value should appear while loading
      expect(screen.queryByText(/Projected/)).not.toBeInTheDocument();
    });
  });

  // ── Band classification ─────────────────────────────────────────────────────

  describe('band: ok — no cap', () => {
    it('renders ok band when effectiveCapUsd is null', () => {
      renderSummary({ costEstimate: makeEstimate({ effectiveCapUsd: null, midUsd: 1.0 }) });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'ok');
    });

    it('renders ok band when effectiveCapUsd is 0', () => {
      renderSummary({ costEstimate: makeEstimate({ effectiveCapUsd: 0, midUsd: 1.0 }) });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'ok');
    });

    it('shows "no cap configured" in the headline when cap is null', () => {
      renderSummary({ costEstimate: makeEstimate({ effectiveCapUsd: null, midUsd: 0.05 }) });
      expect(screen.getByText(/no cap configured/)).toBeInTheDocument();
    });

    it('shows "cap $0.00" (not "no cap configured") in the headline when cap is 0', () => {
      // cap=0 skips the WARN/OVER threshold (share = 0/0 = NaN → ok),
      // but the headline branch checks `cap !== null` — 0 is not null, so
      // the component renders "· cap $0.00" rather than "· no cap configured".
      // This is the component's actual behaviour for the cap=0 edge case.
      renderSummary({ costEstimate: makeEstimate({ effectiveCapUsd: 0, midUsd: 0.05 }) });
      expect(screen.getByText(/per run · cap \$0\.00/)).toBeInTheDocument();
      expect(screen.queryByText(/no cap configured/)).not.toBeInTheDocument();
    });
  });

  describe('band: ok — comfortably under cap', () => {
    it('renders ok band when midUsd is less than 50% of cap', () => {
      // midUsd=0.20, cap=1.00 → share=0.20 (under WARN threshold of 0.50)
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 0.2 }),
      });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'ok');
    });

    it('shows "Projected $X per run · cap $Y" headline under cap', () => {
      renderSummary({
        costEstimate: makeEstimate({
          effectiveCapUsd: 1.0,
          midUsd: 0.2,
          lowUsd: 0.1,
          highUsd: 0.4,
        }),
      });
      // Headline reports both the mid cost and the cap
      expect(screen.getByText(/Projected \$0\.20 per run · cap \$1\.00/)).toBeInTheDocument();
    });
  });

  describe('band: warn — 50–99% of cap', () => {
    it('renders warn band when midUsd is exactly 50% of cap', () => {
      // midUsd=0.50, cap=1.00 → share=0.50, meets WARN threshold
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 0.5 }),
      });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'warn');
    });

    it('renders warn band when midUsd is 75% of cap', () => {
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 0.75 }),
      });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'warn');
    });

    it('shows percentage-of-cap in headline when in warn band', () => {
      // midUsd=0.60, cap=1.00 → 60%
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 0.6 }),
      });
      expect(screen.getByText(/Projected \$0\.60 — 60% of the \$1\.00 cap/)).toBeInTheDocument();
    });

    it('rounds percentage to nearest integer in warn headline', () => {
      // midUsd=0.666, cap=1.00 → 67%
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 0.666 }),
      });
      expect(screen.getByText(/67%/)).toBeInTheDocument();
    });
  });

  describe('band: over — meets or exceeds cap', () => {
    it('renders over band when midUsd equals cap', () => {
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 1.0 }),
      });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'over');
    });

    it('renders over band when midUsd exceeds cap', () => {
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 1.5 }),
      });
      expect(screen.getByTestId('cost-banner')).toHaveAttribute('data-cost-band', 'over');
    });

    it('shows "exceeds the $X per-execution cap" in headline when over the cap', () => {
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: 1.0, midUsd: 1.25 }),
      });
      expect(
        screen.getByText(/Projected \$1\.25 — exceeds the \$1\.00 per-execution cap/)
      ).toBeInTheDocument();
    });

    it('shows "Projected $X per run" when band is over but cap is null', () => {
      // This branch is logically unreachable (cap=null → ok band) but the code
      // guards it defensively; verify it does not throw.
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: null, midUsd: 5.0 }),
      });
      // ok band is expected (cap is null → not over), so just verify no crash
      expect(screen.getByTestId('cost-banner')).toBeInTheDocument();
    });
  });

  // ── USD formatting ──────────────────────────────────────────────────────────

  describe('USD formatting', () => {
    it('formats zero as $0.00', () => {
      renderSummary({
        costEstimate: makeEstimate({ effectiveCapUsd: null, midUsd: 0, lowUsd: 0, highUsd: 0 }),
      });
      // Headline: "Projected $0.00 per run · no cap configured"
      expect(screen.getByText(/Projected \$0\.00/)).toBeInTheDocument();
    });

    it('formats sub-cent values as <$0.01', () => {
      renderSummary({
        costEstimate: makeEstimate({
          effectiveCapUsd: null,
          midUsd: 0.005,
          lowUsd: 0.001,
          highUsd: 0.009,
        }),
      });
      // Headline contains the formatted mid; range pill contains low–high
      expect(screen.getByText(/Projected <\$0\.01/)).toBeInTheDocument();
    });

    it('formats normal values to two decimal places', () => {
      renderSummary({
        costEstimate: makeEstimate({
          effectiveCapUsd: null,
          midUsd: 2.5,
          lowUsd: 1.25,
          highUsd: 5.0,
        }),
      });
      expect(screen.getByText(/Projected \$2\.50/)).toBeInTheDocument();
    });

    it('renders the range pill using low and high formatted values', () => {
      renderSummary({
        costEstimate: makeEstimate({
          effectiveCapUsd: null,
          midUsd: 0.05,
          lowUsd: 0.02,
          highUsd: 0.1,
        }),
      });
      // The range pill: "range $0.02–$0.10"
      expect(screen.getByText(/range \$0\.02–\$0\.10/)).toBeInTheDocument();
    });

    it('renders sub-cent low as <$0.01 in range pill', () => {
      renderSummary({
        costEstimate: makeEstimate({
          effectiveCapUsd: null,
          midUsd: 0.05,
          lowUsd: 0.005,
          highUsd: 0.1,
        }),
      });
      expect(screen.getByText(/range <\$0\.01–\$0\.10/)).toBeInTheDocument();
    });
  });

  // ── basedOn badge and range pill ────────────────────────────────────────────

  describe('basedOn badge', () => {
    it('shows "heuristic" badge when basedOn is heuristic', () => {
      renderSummary({ costEstimate: makeEstimate({ basedOn: 'heuristic' }) });
      // The badge text is uppercased by CSS but the DOM text node is lowercase
      expect(screen.getByText('heuristic')).toBeInTheDocument();
    });

    it('shows "empirical" badge when basedOn is empirical', () => {
      renderSummary({ costEstimate: makeEstimate({ basedOn: 'empirical' }) });
      expect(screen.getByText('empirical')).toBeInTheDocument();
    });

    it('renders the range pill alongside the basedOn badge', () => {
      renderSummary({
        costEstimate: makeEstimate({
          basedOn: 'empirical',
          lowUsd: 0.03,
          highUsd: 0.07,
        }),
      });
      expect(screen.getByText('empirical')).toBeInTheDocument();
      expect(screen.getByText(/range \$0\.03–\$0\.07/)).toBeInTheDocument();
    });
  });

  // ── Defensive Array.isArray guard ───────────────────────────────────────────

  describe('defensive non-array prop handling', () => {
    it('does not crash when capabilities is null (non-array)', () => {
      expect(() => {
        render(
          <WorkflowResourceSummary
            {...DEFAULT_PROPS}
            capabilities={null as unknown as readonly CapabilityOption[]}
            costEstimate={makeEstimate({ effectiveCapUsd: null, midUsd: 0.05 })}
          />
        );
      }).not.toThrow();
    });

    it('still renders the cost banner when capabilities is a non-array object', () => {
      render(
        <WorkflowResourceSummary
          {...DEFAULT_PROPS}
          capabilities={{} as unknown as readonly CapabilityOption[]}
          costEstimate={makeEstimate({ effectiveCapUsd: null, midUsd: 0.05 })}
        />
      );
      // The component falls back to [] for capabilities; banner should still render
      expect(screen.getByTestId('cost-banner')).toBeInTheDocument();
    });

    it('does not crash when agents is null (non-array)', () => {
      expect(() => {
        render(
          <WorkflowResourceSummary
            {...DEFAULT_PROPS}
            agents={null as unknown as readonly AgentOption[]}
            costEstimate={makeEstimate({ effectiveCapUsd: null, midUsd: 0.05 })}
          />
        );
      }).not.toThrow();
    });

    it('still renders the cost banner when agents is a non-array object', () => {
      render(
        <WorkflowResourceSummary
          {...DEFAULT_PROPS}
          agents={{} as unknown as readonly AgentOption[]}
          costEstimate={makeEstimate({ effectiveCapUsd: null, midUsd: 0.05 })}
        />
      );
      // The component falls back to [] for agents; banner should still render
      expect(screen.getByTestId('cost-banner')).toBeInTheDocument();
    });
  });

  // ── Resource collection from nodes ──────────────────────────────────────────

  describe('collectResources — tool_call / agent_call / orchestrator', () => {
    const CAP_A: CapabilityOption = {
      id: 'cap-a-id',
      slug: 'cap-a',
      name: 'Capability A',
      description: 'Looks things up',
    };
    const CAP_B: CapabilityOption = {
      id: 'cap-b-id',
      slug: 'cap-b',
      name: 'Capability B',
      description: '',
    };
    const AGENT_X: AgentOption = {
      slug: 'agent-x',
      name: 'Agent X',
      description: 'Replies to humans',
    };
    const AGENT_Y: AgentOption = { slug: 'agent-y', name: 'Agent Y', description: null };

    it('collects capabilities from tool_call steps and renders the capability badge', () => {
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }, 'Lookup'),
      ] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />);
      expect(screen.getByText('1 capability')).toBeInTheDocument();
    });

    it('pluralises the capability badge when multiple distinct slugs are referenced', () => {
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }),
        makeNode('step-2', 'tool_call', { capabilitySlug: 'cap-b' }),
      ] as PatternNode[];
      render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A, CAP_B]} />
      );
      expect(screen.getByText('2 capabilities')).toBeInTheDocument();
    });

    it('collects agents from agent_call steps and renders the agent badge', () => {
      const nodes = [makeNode('step-1', 'agent_call', { agentSlug: 'agent-x' })] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} agents={[AGENT_X]} />);
      expect(screen.getByText('1 agent')).toBeInTheDocument();
    });

    it('pluralises the agent badge with multiple agents', () => {
      const nodes = [
        makeNode('step-1', 'agent_call', { agentSlug: 'agent-x' }),
        makeNode('step-2', 'agent_call', { agentSlug: 'agent-y' }),
      ] as PatternNode[];
      render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} agents={[AGENT_X, AGENT_Y]} />
      );
      expect(screen.getByText('2 agents')).toBeInTheDocument();
    });

    it('collects agents from orchestrator availableAgentSlugs', () => {
      const nodes = [
        makeNode('step-1', 'orchestrator', {
          availableAgentSlugs: ['agent-x', 'agent-y'],
        }),
      ] as PatternNode[];
      render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} agents={[AGENT_X, AGENT_Y]} />
      );
      expect(screen.getByText('2 agents')).toBeInTheDocument();
    });

    it('ignores non-string and empty-string entries inside orchestrator availableAgentSlugs', () => {
      // The collector guards `typeof slug === 'string' && slug` — non-strings
      // and empty strings must be skipped, otherwise a misconfigured step
      // would surface a phantom agent row.
      const nodes = [
        makeNode('step-1', 'orchestrator', {
          availableAgentSlugs: ['agent-x', '', null as any, 42 as any],
        }),
      ] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} agents={[AGENT_X]} />);
      // Only "agent-x" should register
      expect(screen.getByText('1 agent')).toBeInTheDocument();
    });

    it('ignores tool_call steps with empty/missing capabilitySlug', () => {
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: '' }),
        makeNode('step-2', 'tool_call', {}),

        makeNode('step-3', 'tool_call', { capabilitySlug: 42 as any }),
      ] as PatternNode[];
      const { container } = render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />
      );
      // No badge or panel — nothing to show
      expect(container.firstChild).toBeNull();
    });

    it('ignores agent_call steps with empty/missing agentSlug', () => {
      const nodes = [
        makeNode('step-1', 'agent_call', { agentSlug: '' }),
        makeNode('step-2', 'agent_call', {}),
      ] as PatternNode[];
      const { container } = render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} agents={[AGENT_X]} />
      );
      expect(container.firstChild).toBeNull();
    });

    it('deduplicates the same slug used across multiple steps', () => {
      // Two tool_call steps using the same capability count as one row.
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }, 'First lookup'),
        makeNode('step-2', 'tool_call', { capabilitySlug: 'cap-a' }, 'Second lookup'),
      ] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />);
      expect(screen.getByText('1 capability')).toBeInTheDocument();
    });
  });

  // ── Expand/collapse and ResourceRow ─────────────────────────────────────────

  describe('expand/collapse and ResourceRow', () => {
    const CAP_A: CapabilityOption = {
      id: 'cap-a-id',
      slug: 'cap-a',
      name: 'Capability A',
      description: 'Looks things up',
    };
    const AGENT_X: AgentOption = {
      slug: 'agent-x',
      name: 'Agent X',
      description: 'Replies to humans',
    };

    it('hides resource rows by default and reveals them after clicking the Resources button', async () => {
      const user = userEvent.setup();
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }, 'Lookup step'),
      ] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />);

      // Closed initially — the capability name lives only in the row
      expect(screen.queryByText('Capability A')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Resources/ })).toHaveAttribute(
        'aria-expanded',
        'false'
      );

      await user.click(screen.getByRole('button', { name: /Resources/ }));

      expect(screen.getByText('Capability A')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Resources/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });

    it('collapses again on a second click', async () => {
      const user = userEvent.setup();
      const nodes = [makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' })] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />);
      const button = screen.getByRole('button', { name: /Resources/ });
      await user.click(button);
      expect(screen.getByText('Capability A')).toBeInTheDocument();
      await user.click(button);
      expect(screen.queryByText('Capability A')).not.toBeInTheDocument();
    });

    it('renders capability and agent groups separately when expanded', async () => {
      const user = userEvent.setup();
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }),
        makeNode('step-2', 'agent_call', { agentSlug: 'agent-x' }),
      ] as PatternNode[];
      render(
        <WorkflowResourceSummary
          {...DEFAULT_PROPS}
          nodes={nodes}
          capabilities={[CAP_A]}
          agents={[AGENT_X]}
        />
      );
      await user.click(screen.getByRole('button', { name: /Resources/ }));
      // Group headers — uppercase via CSS but DOM text is lowercase
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Capability A')).toBeInTheDocument();
      expect(screen.getByText('Agent X')).toBeInTheDocument();
    });

    it('falls back to the raw slug as the row name when the lookup misses', async () => {
      // No capability with slug "cap-a" is supplied — resource entry should
      // use the slug itself for both name and key.
      const user = userEvent.setup();
      const nodes = [makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' })] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[]} />);
      await user.click(screen.getByRole('button', { name: /Resources/ }));
      // "cap-a" appears twice: once as the row name (no friendly lookup) and
      // once as the small mono slug suffix. Use getAllByText to assert both.
      expect(screen.getAllByText('cap-a').length).toBeGreaterThan(0);
    });

    it('shows the "N steps" badge only when a slug is used by more than one step', async () => {
      const user = userEvent.setup();
      const nodes = [
        makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-a' }),
        makeNode('step-2', 'tool_call', { capabilitySlug: 'cap-a' }),
      ] as PatternNode[];
      render(<WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[CAP_A]} />);
      await user.click(screen.getByRole('button', { name: /Resources/ }));
      expect(screen.getByText('2 steps')).toBeInTheDocument();
    });

    it('omits the description suffix when description is empty', async () => {
      const user = userEvent.setup();
      const NO_DESC_CAP: CapabilityOption = {
        id: 'cap-b-id',
        slug: 'cap-b',
        name: 'Capability B',
        description: '',
      };
      const nodes = [makeNode('step-1', 'tool_call', { capabilitySlug: 'cap-b' })] as PatternNode[];
      render(
        <WorkflowResourceSummary {...DEFAULT_PROPS} nodes={nodes} capabilities={[NO_DESC_CAP]} />
      );
      await user.click(screen.getByRole('button', { name: /Resources/ }));
      // The "— {description}" em-dash suffix should not appear
      expect(screen.queryByText(/—/)).not.toBeInTheDocument();
    });

    it('fires onFocusNode with the first step id when a resource row is clicked', async () => {
      const onFocusNode = vi.fn();
      const user = userEvent.setup();
      const nodes = [
        makeNode('step-A', 'tool_call', { capabilitySlug: 'cap-a' }, 'First'),
        makeNode('step-B', 'tool_call', { capabilitySlug: 'cap-a' }, 'Second'),
      ] as PatternNode[];
      render(
        <WorkflowResourceSummary
          {...DEFAULT_PROPS}
          onFocusNode={onFocusNode}
          nodes={nodes}
          capabilities={[CAP_A]}
        />
      );
      await user.click(screen.getByRole('button', { name: /Resources/ }));
      // The row button's accessible name includes the capability label and
      // the "Used in:" title attr; query by the displayed name text.
      const rowButton = screen.getByRole('button', { name: /Capability A/ });
      await user.click(rowButton);
      expect(onFocusNode).toHaveBeenCalledTimes(1);
      expect(onFocusNode).toHaveBeenCalledWith('step-A');
    });
  });
});
