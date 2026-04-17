/**
 * Unit Tests: BlockConfigPanel
 *
 * Test Coverage:
 * - Each of the 9 step types renders the correct editor
 * - onLabelChange fires when editing the step name
 * - onConfigChange(nodeId, partial) fires when an editor signals a change
 * - onDelete(nodeId) fires when Delete is clicked
 *
 * @see components/admin/orchestration/workflow-builder/block-config-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BlockConfigPanel } from '@/components/admin/orchestration/workflow-builder/block-config-panel';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import type { CapabilityOption } from '@/components/admin/orchestration/workflow-builder/block-editors';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeNode(
  type: PatternNode['data']['type'],
  config: Record<string, unknown> = {},
  label = 'Test Step',
  id = 'step-test-1'
): PatternNode {
  return {
    id,
    type: 'pattern',
    position: { x: 0, y: 0 },
    data: { label, type, config },
  };
}

const CAPABILITIES: CapabilityOption[] = [
  {
    id: 'cap-1',
    slug: 'web-search',
    name: 'Web Search',
    description: 'Search the web.',
  },
];

const DEFAULT_PROPS = {
  onLabelChange: vi.fn(),
  onConfigChange: vi.fn(),
  onDelete: vi.fn(),
  capabilities: CAPABILITIES,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BlockConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('renders the correct editor for each step type', () => {
    it('llm_call: renders the LLM prompt textarea', () => {
      const node = makeNode('llm_call', { prompt: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('llm-prompt')).toBeInTheDocument();
    });

    it('chain: renders the placeholder message about Session 5.1c', () => {
      const node = makeNode('chain', {});
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(screen.getByText(/session 5\.1c/i)).toBeInTheDocument();
    });

    it('route: renders the classification prompt textarea', () => {
      const node = makeNode('route', { classificationPrompt: '', routes: [] });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('route-classification')).toBeInTheDocument();
    });

    it('parallel: renders the timeout input', () => {
      const node = makeNode('parallel', {});
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('parallel-timeout')).toBeInTheDocument();
    });

    it('reflect: renders the critique prompt textarea', () => {
      const node = makeNode('reflect', { critiquePrompt: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('reflect-critique')).toBeInTheDocument();
    });

    it('tool_call: renders the capability select or "No capabilities" message', () => {
      const node = makeNode('tool_call', { capabilitySlug: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      // With capabilities provided, should render the capability Select combobox
      // (plus the error strategy Select, so there are at least 2 comboboxes)
      const comboboxes = screen.getAllByRole('combobox');
      expect(comboboxes.length).toBeGreaterThanOrEqual(2);
    });

    it('tool_call with empty capabilities: renders "No capabilities available"', () => {
      const node = makeNode('tool_call', { capabilitySlug: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} capabilities={[]} />);
      expect(screen.getByText(/no capabilities available/i)).toBeInTheDocument();
    });

    it('plan: renders the objective textarea', () => {
      const node = makeNode('plan', { objective: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('plan-objective')).toBeInTheDocument();
    });

    it('human_approval: renders the approval message textarea', () => {
      const node = makeNode('human_approval', { prompt: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('approval-prompt')).toBeInTheDocument();
    });

    it('rag_retrieve: renders the search query textarea', () => {
      const node = makeNode('rag_retrieve', { query: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('rag-query')).toBeInTheDocument();
    });
  });

  describe('step name editing', () => {
    it('displays the node label in the name input', () => {
      const node = makeNode('llm_call', { prompt: '' }, 'My LLM Step');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);

      const nameInput = document.getElementById('step-name') as HTMLInputElement;
      expect(nameInput?.value).toBe('My LLM Step');
    });

    it('calls onLabelChange with nodeId and new value when typing in name input', async () => {
      const user = userEvent.setup();
      const onLabelChange = vi.fn();
      const node = makeNode('llm_call', { prompt: '' }, 'Old Label', 'step-abc');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onLabelChange={onLabelChange} />);

      const nameInput = document.getElementById('step-name') as HTMLInputElement;
      await user.type(nameInput, '!');

      expect(onLabelChange).toHaveBeenCalled();
      const calls = onLabelChange.mock.calls;
      expect(calls[calls.length - 1][0]).toBe('step-abc');
    });
  });

  describe('config change propagation', () => {
    it('calls onConfigChange when user types in the LLM prompt', async () => {
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode('llm_call', { prompt: '' }, 'LLM', 'step-llm');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      await user.type(document.getElementById('llm-prompt')!, 'A');

      expect(onConfigChange).toHaveBeenCalled();
      const calls = onConfigChange.mock.calls;
      expect(calls[calls.length - 1][0]).toBe('step-llm');
      expect(calls[calls.length - 1][1]).toHaveProperty('prompt');
    });
  });

  describe('delete button', () => {
    it('calls onDelete with the nodeId when Delete is clicked', async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      const node = makeNode('llm_call', { prompt: '' }, 'My Step', 'step-del');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onDelete={onDelete} />);

      await user.click(screen.getByRole('button', { name: /delete/i }));

      expect(onDelete).toHaveBeenCalledWith('step-del');
    });
  });

  describe('step id display', () => {
    it('shows the step id in the panel', () => {
      const node = makeNode('llm_call', {}, 'Step', 'step-id-test');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);

      expect(screen.getByText('step-id-test')).toBeInTheDocument();
    });
  });
});
