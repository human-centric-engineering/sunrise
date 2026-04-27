/**
 * Unit Tests: BlockConfigPanel
 *
 * Test Coverage:
 * - Each of the 12 step types renders the correct editor (including guard,
 *   evaluate, external_call, and the unknown-type fallback)
 * - onLabelChange fires with the correct nodeId AND new label value
 * - onConfigChange(nodeId, partial) fires with the correct nodeId AND config
 *   values for multiple block types (llm_call, guard, evaluate)
 * - onDelete(nodeId) fires when Delete is clicked
 * - Error-handling section: errorStrategy select, conditional retryCount /
 *   fallbackStepId fields, and field-clearing on strategy change
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
  agents: [] as Array<{ slug: string; name: string; description: string | null }>,
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

    it('tool_call with capabilities: renders the capability selector trigger', () => {
      // The ToolCallEditor renders a shadcn Select when capabilities are provided.
      // We assert the SelectTrigger (id="tool-capability") is present rather than
      // counting all comboboxes — that way the test is specific to the capability
      // selector, not the always-present error-strategy select.
      const node = makeNode('tool_call', { capabilitySlug: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('tool-capability')).toBeInTheDocument();
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

    it('guard: renders the guard rules textarea', () => {
      const node = makeNode('guard', { rules: '', mode: 'llm', failAction: 'block' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('guard-rules')).toBeInTheDocument();
    });

    it('evaluate: renders the rubric textarea', () => {
      const node = makeNode('evaluate', { rubric: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('evaluate-rubric')).toBeInTheDocument();
    });

    it('external_call: renders the URL input', () => {
      const node = makeNode('external_call', { url: '', method: 'POST' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('ext-url')).toBeInTheDocument();
    });

    it('orchestrator: renders the planner prompt textarea', () => {
      const node = makeNode('orchestrator', {
        plannerPrompt: '',
        availableAgentSlugs: [],
      });
      const agents = [{ slug: 'researcher', name: 'Researcher', description: 'Finds info' }];
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} agents={agents} />);
      expect(document.getElementById('orchestrator-prompt')).toBeInTheDocument();
    });

    it('orchestrator: passes agents to the editor and renders agent checkboxes', () => {
      const node = makeNode('orchestrator', {
        plannerPrompt: '',
        availableAgentSlugs: [],
      });
      const agents = [
        { slug: 'researcher', name: 'Researcher', description: 'Finds info' },
        { slug: 'analyst', name: 'Analyst', description: 'Analyzes data' },
      ];
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} agents={agents} />);
      expect(screen.getByText('Researcher')).toBeInTheDocument();
      expect(screen.getByText('Analyst')).toBeInTheDocument();
    });

    it('unknown block type: renders the fallback "no editor" message', () => {
      // Cast through unknown to bypass TS — simulates a runtime type unknown to
      // the switch (e.g. a new type added to the registry not yet in the editor).
      const node = makeNode('llm_call', {});
      const unknownNode = {
        ...node,
        data: { ...node.data, type: 'unknown_future_type' as PatternNode['data']['type'] },
      };
      render(<BlockConfigPanel node={unknownNode} {...DEFAULT_PROPS} />);
      // The fallback <p> contains both static text and the type in a <code>.
      // Use getAllByText which allows partial matches across element boundaries,
      // and confirm "no editor registered" text is present.
      const fallbackEls = screen.getAllByText(/no editor registered/i);
      expect(fallbackEls.length).toBeGreaterThanOrEqual(1);
      // The type slug appears in a <code> element inside the fallback paragraph.
      // There can be multiple <code> elements (e.g. the step-id display), so
      // find the one containing our type slug.
      const codeEls = Array.from(document.querySelectorAll('code'));
      const typeCodeEl = codeEls.find((el) => el.textContent === 'unknown_future_type');
      expect(typeCodeEl).toBeDefined();
    });
  });

  describe('step name editing', () => {
    it('displays the node label in the name input', () => {
      const node = makeNode('llm_call', { prompt: '' }, 'My LLM Step');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);

      const nameInput = document.getElementById('step-name') as HTMLInputElement;
      expect(nameInput?.value).toBe('My LLM Step');
    });

    it('calls onLabelChange with nodeId AND the updated label value when typing', async () => {
      // Arrange
      const user = userEvent.setup();
      const onLabelChange = vi.fn();
      const node = makeNode('llm_call', { prompt: '' }, 'Old Label', 'step-abc');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onLabelChange={onLabelChange} />);

      const nameInput = document.getElementById('step-name') as HTMLInputElement;

      // Act: type a single character — the onChange fires once with the full
      // new value that the controlled input would have
      await user.type(nameInput, '!');

      // Assert: nodeId is the first arg; the second arg must be the new label
      // (the component does NOT just forward the keypress — it passes the full
      // e.target.value which includes the initial text from the controlled prop)
      expect(onLabelChange).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
      const lastCall = onLabelChange.mock.calls[onLabelChange.mock.calls.length - 1];
      expect(lastCall[0]).toBe('step-abc');
      // The label should end with the typed character
      expect(lastCall[1]).toContain('!');
      // Ensure the value is a string, not an event object
      expect(typeof lastCall[1]).toBe('string');
    });
  });

  describe('config change propagation', () => {
    it('llm_call: calls onConfigChange with nodeId and the typed prompt value', async () => {
      // Arrange
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode('llm_call', { prompt: '' }, 'LLM', 'step-llm');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: type a single character. The LlmCallEditor textarea is controlled
      // (value={config.prompt}). Because config is never updated between renders
      // in this test, e.target.value after a single keypress is just that
      // character — onChange receives { prompt: 'A' }.
      await user.type(document.getElementById('llm-prompt')!, 'A');

      // Assert: first arg is nodeId; second is the partial with the correct key
      // and the typed character as its value.
      expect(onConfigChange).toHaveBeenCalledWith('step-llm', { prompt: 'A' });
    });

    it('guard: calls onConfigChange with nodeId and the typed rules value', async () => {
      // Arrange
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode(
        'guard',
        { rules: '', mode: 'llm', failAction: 'block' },
        'Guard Step',
        'step-guard'
      );
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: type a single character into the guard rules textarea. The GuardEditor
      // textarea is controlled (value={config.rules}), so each keypress produces
      // onChange({ rules: '<typed-char>' }).
      await user.type(document.getElementById('guard-rules')!, 'R');

      // Assert: nodeId and the partial with the correct key + typed character
      expect(onConfigChange).toHaveBeenCalledWith('step-guard', { rules: 'R' });
    });

    it('evaluate: calls onConfigChange with nodeId and the typed rubric value', async () => {
      // Arrange
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode('evaluate', { rubric: '' }, 'Evaluate Step', 'step-eval');
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: type a single character into the rubric textarea. The EvaluateEditor
      // textarea is controlled (value={config.rubric}), so each keypress produces
      // onChange({ rubric: '<typed-char>' }).
      await user.type(document.getElementById('evaluate-rubric')!, 'E');

      // Assert: nodeId and the partial with the correct key + typed character
      expect(onConfigChange).toHaveBeenCalledWith('step-eval', { rubric: 'E' });
    });

    it('external_call: calls onConfigChange with nodeId and the typed URL value', async () => {
      // Arrange
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode(
        'external_call',
        { url: '', method: 'POST' },
        'External Step',
        'step-ext'
      );
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: type into the URL input
      await user.type(document.getElementById('ext-url')!, 'https://api.example.com');

      // Assert
      expect(onConfigChange).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
      const lastCall = onConfigChange.mock.calls[onConfigChange.mock.calls.length - 1];
      expect(lastCall[0]).toBe('step-ext');
      expect(lastCall[1]).toHaveProperty('url');
      expect(typeof lastCall[1].url).toBe('string');
      expect((lastCall[1].url as string).length).toBeGreaterThan(0);
    });
  });

  describe('error handling section', () => {
    it('does not render the retry count input when errorStrategy is not "retry"', () => {
      // Default config has no errorStrategy, so retry count should be hidden
      const node = makeNode('llm_call', { prompt: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('retry-count')).not.toBeInTheDocument();
    });

    it('renders retry count input when errorStrategy is "retry"', () => {
      const node = makeNode('llm_call', { prompt: '', errorStrategy: 'retry', retryCount: 3 });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('retry-count')).toBeInTheDocument();
    });

    it('does not render the fallback step input when errorStrategy is not "fallback"', () => {
      const node = makeNode('llm_call', { prompt: '' });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('fallback-step')).not.toBeInTheDocument();
    });

    it('renders fallback step input when errorStrategy is "fallback"', () => {
      const node = makeNode('llm_call', {
        prompt: '',
        errorStrategy: 'fallback',
        fallbackStepId: 'step-b',
      });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} />);
      expect(document.getElementById('fallback-step')).toBeInTheDocument();
    });

    it('clears retryCount when switching away from "retry" strategy', async () => {
      // Arrange: start with retry strategy active
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode('llm_call', { prompt: '', errorStrategy: 'retry', retryCount: 3 });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: open the error-strategy select and pick "skip"
      // The Select is a shadcn/ui combobox — click the trigger then the item
      const trigger = document.getElementById('error-strategy');
      await user.click(trigger!);
      await user.click(screen.getByRole('option', { name: /skip/i }));

      // Assert: the partial passed to onConfigChange must include
      // retryCount: undefined (field clearing logic in onValueChange)
      const calls = onConfigChange.mock.calls;
      const configPartials = calls.map((c) => c[1] as Record<string, unknown>);
      const clearingCall = configPartials.find(
        (p) => 'retryCount' in p && p.retryCount === undefined
      );
      expect(clearingCall).toBeDefined();
    });

    it('clears fallbackStepId when switching away from "fallback" strategy', async () => {
      // Arrange: start with fallback strategy active
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      const node = makeNode('llm_call', {
        prompt: '',
        errorStrategy: 'fallback',
        fallbackStepId: 'step-b',
      });
      render(<BlockConfigPanel node={node} {...DEFAULT_PROPS} onConfigChange={onConfigChange} />);

      // Act: switch to "retry"
      const trigger = document.getElementById('error-strategy');
      await user.click(trigger!);
      await user.click(screen.getByRole('option', { name: /retry/i }));

      // Assert: fallbackStepId must be cleared
      const calls = onConfigChange.mock.calls;
      const configPartials = calls.map((c) => c[1] as Record<string, unknown>);
      const clearingCall = configPartials.find(
        (p) => 'fallbackStepId' in p && p.fallbackStepId === undefined
      );
      expect(clearingCall).toBeDefined();
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
