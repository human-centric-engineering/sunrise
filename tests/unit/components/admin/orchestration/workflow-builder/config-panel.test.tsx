/**
 * Unit Tests: ConfigPanel
 *
 * Test Coverage:
 * - Type badge shows correct label for a known type
 * - Name input reflects node label
 * - Typing in name input calls onLabelChange
 * - Clicking Delete calls onDelete
 * - config JSON pre element contains formatted JSON
 * - FieldHelp for "Per-step configuration editors…5.1b" is in the DOM
 *
 * @see components/admin/orchestration/workflow-builder/config-panel.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfigPanel } from '@/components/admin/orchestration/workflow-builder/config-panel';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<PatternNode> = {}): PatternNode {
  return {
    id: 'step_abc12345',
    type: 'pattern',
    position: { x: 0, y: 0 },
    data: {
      label: 'My step',
      type: 'llm_call',
      config: { prompt: 'hello' },
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConfigPanel', () => {
  describe('type badge', () => {
    it('shows "LLM Call" as the type badge label for llm_call', () => {
      const node = makeNode();
      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      expect(screen.getByText('LLM Call')).toBeInTheDocument();
    });

    it('shows correct label for route type', () => {
      const node = makeNode({ data: { label: 'Router', type: 'route', config: {} } });
      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      expect(screen.getByText('Route')).toBeInTheDocument();
    });
  });

  describe('name input', () => {
    it("shows the node label as the input's value", () => {
      const node = makeNode({ data: { label: 'My step', type: 'llm_call', config: {} } });
      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      // Fall back to the labeled input with id "step-name"
      const stepInput = document.getElementById('step-name');
      expect((stepInput as HTMLInputElement | null)?.value).toBe('My step');
    });

    it('calls onLabelChange with nodeId and new value when typing', async () => {
      const user = userEvent.setup();
      const onLabelChange = vi.fn();
      const node = makeNode({
        id: 'step_abc',
        data: { label: 'Old label', type: 'llm_call', config: {} },
      });

      render(<ConfigPanel node={node} onLabelChange={onLabelChange} onDelete={vi.fn()} />);

      // The step name input has id="step-name"
      const input = document.getElementById('step-name') as HTMLInputElement;
      // Clear and type new value
      await user.clear(input);
      await user.type(input, 'New label');

      // onLabelChange should have been called during typing
      expect(onLabelChange).toHaveBeenCalled();
      // The last call should include the nodeId
      const calls = onLabelChange.mock.calls;
      expect(calls[calls.length - 1][0]).toBe('step_abc');
    });
  });

  describe('delete button', () => {
    it('calls onDelete with the nodeId when clicked', async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      const node = makeNode({ id: 'step_xyz' });

      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={onDelete} />);

      const deleteBtn = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteBtn);

      expect(onDelete).toHaveBeenCalledWith('step_xyz');
    });
  });

  describe('config JSON display', () => {
    it('pre element contains formatted JSON of node config', () => {
      const config = { prompt: 'hello', maxTokens: 1024 };
      const node = makeNode({ data: { label: 'My step', type: 'llm_call', config } });

      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      const pre = screen.getByTestId('config-panel-json');
      expect(pre.textContent).toBe(JSON.stringify(config, null, 2));
    });

    it('pre element shows empty object for empty config', () => {
      const node = makeNode({ data: { label: 'Step', type: 'llm_call', config: {} } });

      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      const pre = screen.getByTestId('config-panel-json');
      expect(pre.textContent).toBe('{}');
    });
  });

  describe('FieldHelp for session 5.1b', () => {
    it('renders an info trigger button for the configuration FieldHelp', async () => {
      const user = userEvent.setup();
      const node = makeNode();
      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      // There should be at least one "More information" button for the config FieldHelp
      const infoButtons = screen.getAllByRole('button', { name: /more information/i });
      expect(infoButtons.length).toBeGreaterThanOrEqual(1);

      // Click the last one (config FieldHelp is after Name FieldHelp)
      await user.click(infoButtons[infoButtons.length - 1]);

      // After clicking, popover content with 5.1b reference should appear
      expect(document.body.innerHTML).toContain('Session 5.1b');
    });
  });

  describe('step id section', () => {
    it('renders the step id in the panel', () => {
      const node = makeNode({ id: 'step_abc12345' });
      render(<ConfigPanel node={node} onLabelChange={vi.fn()} onDelete={vi.fn()} />);

      expect(screen.getByText('step_abc12345')).toBeInTheDocument();
    });
  });
});
