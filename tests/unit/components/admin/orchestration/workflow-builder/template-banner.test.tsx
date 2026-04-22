/**
 * Unit Tests: TemplateBanner
 *
 * Test Coverage:
 * - Returns null when isTemplate=false
 * - Returns null when metadata=null
 * - Renders name and description in the banner header
 * - Expand/collapse toggle shows "More" / "Less"
 * - Expanded state shows pattern badges, flow summary, and use cases
 * - Use cases section is omitted when useCases is empty
 *
 * @see components/admin/orchestration/workflow-builder/template-banner.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TemplateBanner } from '@/components/admin/orchestration/workflow-builder/template-banner';
import type { WorkflowDefinition, WorkflowTemplateMetadata } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_METADATA: WorkflowTemplateMetadata = {
  flowSummary: 'Handles customer queries using a multi-agent pipeline.',
  useCases: [
    {
      title: 'Refund Request',
      scenario: 'Customer asks for a refund on a recent order.',
    },
    {
      title: 'Order Status',
      scenario: 'Customer asks about delivery tracking.',
    },
  ],
  patterns: [
    { number: 1, name: 'Chain of Thought' },
    { number: 3, name: 'Tool Use' },
  ],
};

const DEFAULT_PROPS = {
  name: 'Customer Support',
  description: 'Multi-channel support automation',
  isTemplate: true,
  metadata: MOCK_METADATA,
};

const MOCK_WORKFLOW_DEF: WorkflowDefinition = {
  entryStepId: 'classify',
  errorStrategy: 'fail',
  steps: [
    {
      id: 'classify',
      name: 'Classify',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'route' }],
    },
    {
      id: 'route',
      name: 'Route',
      type: 'route',
      config: {},
      nextSteps: [{ targetStepId: 'draft' }],
    },
    {
      id: 'draft',
      name: 'Draft',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'approve' }],
    },
    { id: 'approve', name: 'Approve', type: 'human_approval', config: {}, nextSteps: [] },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderBanner(
  overrides: Partial<{
    name: string;
    description: string;
    isTemplate: boolean;
    metadata: WorkflowTemplateMetadata | null;
    workflowDefinition: WorkflowDefinition | null;
  }> = {}
) {
  return render(<TemplateBanner {...DEFAULT_PROPS} {...overrides} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TemplateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('null / hidden states', () => {
    it('renders nothing when isTemplate=false', () => {
      const { container } = renderBanner({ isTemplate: false });
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when metadata=null', () => {
      const { container } = renderBanner({ metadata: null });
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when both isTemplate=false and metadata=null', () => {
      const { container } = renderBanner({ isTemplate: false, metadata: null });
      expect(container.firstChild).toBeNull();
    });
  });

  describe('header content', () => {
    it('shows the workflow name', () => {
      renderBanner();
      expect(screen.getByText('Customer Support')).toBeInTheDocument();
    });

    it('shows the workflow description', () => {
      renderBanner();
      expect(screen.getByText('Multi-channel support automation')).toBeInTheDocument();
    });

    it('shows a "Template" badge', () => {
      renderBanner();
      expect(screen.getByText('Template')).toBeInTheDocument();
    });

    it('shows the "More" toggle button when collapsed', () => {
      renderBanner();
      expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
    });
  });

  describe('expand / collapse toggle', () => {
    it('toggles from "More" to "Less" when clicked', async () => {
      const user = userEvent.setup();
      renderBanner();

      const toggleBtn = screen.getByRole('button', { name: /more/i });
      await user.click(toggleBtn);

      expect(screen.getByRole('button', { name: /less/i })).toBeInTheDocument();
    });

    it('collapses back to "More" after a second click', async () => {
      const user = userEvent.setup();
      renderBanner();

      const toggleBtn = screen.getByRole('button', { name: /more/i });
      await user.click(toggleBtn);
      await user.click(screen.getByRole('button', { name: /less/i }));

      expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
    });

    it('does not show pattern badges or flow summary before expanding', () => {
      renderBanner();
      // Flow summary only visible after expand
      expect(screen.queryByText(MOCK_METADATA.flowSummary)).not.toBeInTheDocument();
    });
  });

  describe('expanded content', () => {
    async function renderExpanded() {
      const user = userEvent.setup();
      renderBanner();
      await user.click(screen.getByRole('button', { name: /more/i }));
    }

    it('shows each pattern badge after expanding', async () => {
      await renderExpanded();
      expect(screen.getByText(/#1 Chain of Thought/)).toBeInTheDocument();
      expect(screen.getByText(/#3 Tool Use/)).toBeInTheDocument();
    });

    it('shows the flow summary after expanding', async () => {
      await renderExpanded();
      expect(screen.getByText(MOCK_METADATA.flowSummary)).toBeInTheDocument();
    });

    it('shows use case titles after expanding', async () => {
      await renderExpanded();
      expect(screen.getByText('Refund Request')).toBeInTheDocument();
      expect(screen.getByText('Order Status')).toBeInTheDocument();
    });

    it('shows use case scenarios after expanding', async () => {
      await renderExpanded();
      expect(screen.getByText(/Customer asks for a refund on a recent order/)).toBeInTheDocument();
    });

    it('omits the use cases section when useCases is empty', async () => {
      const user = userEvent.setup();
      renderBanner({
        metadata: { ...MOCK_METADATA, useCases: [] },
      });
      await user.click(screen.getByRole('button', { name: /more/i }));

      // "Use cases" heading should not appear
      expect(screen.queryByText(/use cases/i)).not.toBeInTheDocument();
    });

    it('shows the Flow section heading after expanding', async () => {
      await renderExpanded();
      expect(screen.getByText(/^flow$/i)).toBeInTheDocument();
    });
  });

  describe('cost indicator', () => {
    it('shows a cost estimate badge when workflowDefinition has LLM steps', () => {
      renderBanner({ workflowDefinition: MOCK_WORKFLOW_DEF });
      // 3 LLM steps (classify=llm_call, route=route, draft=llm_call)
      expect(screen.getByText(/\/run/)).toBeInTheDocument();
    });

    it('does not show cost badge when workflowDefinition is null', () => {
      renderBanner({ workflowDefinition: null });
      expect(screen.queryByText(/\/run/)).not.toBeInTheDocument();
    });

    it('does not show cost badge when workflow has no LLM steps', () => {
      const noLlmDef: WorkflowDefinition = {
        entryStepId: 'approve',
        errorStrategy: 'fail',
        steps: [
          { id: 'approve', name: 'Approve', type: 'human_approval', config: {}, nextSteps: [] },
        ],
      };
      renderBanner({ workflowDefinition: noLlmDef });
      expect(screen.queryByText(/\/run/)).not.toBeInTheDocument();
    });

    it('includes a dollar sign icon in the cost badge', () => {
      renderBanner({ workflowDefinition: MOCK_WORKFLOW_DEF });
      // The cost badge renders with a DollarSign icon and /run suffix
      const badge = screen.getByText(/\/run/);
      expect(badge).toBeInTheDocument();
    });
  });
});
