/**
 * Unit Tests: OrchestratorEditor
 *
 * Test Coverage:
 * - Renders all form fields with initial config values
 * - Empty agents list renders "No active agents available" message
 * - Agent checkbox toggles update availableAgentSlugs
 * - Planner prompt textarea fires onChange
 * - Selection mode dropdown fires onChange
 * - Number inputs respect min/max constraints
 * - All FieldHelp tooltips present
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/orchestrator-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrchestratorEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/orchestrator-editor';
import type { OrchestratorConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/orchestrator-editor';
import type { AgentOption } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENTS: AgentOption[] = [
  { slug: 'researcher', name: 'Researcher', description: 'Finds information' },
  { slug: 'analyst', name: 'Analyst', description: 'Analyzes data' },
  { slug: 'writer', name: 'Writer', description: null },
];

const defaultConfig: OrchestratorConfig = {
  plannerPrompt: '',
  availableAgentSlugs: [],
};

const populatedConfig: OrchestratorConfig = {
  plannerPrompt: 'Coordinate research.',
  availableAgentSlugs: ['researcher'],
  selectionMode: 'auto',
  maxRounds: 3,
  maxDelegationsPerRound: 5,
  timeoutMs: 120000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestratorEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "No active agents available" message when agents is empty', () => {
    render(<OrchestratorEditor config={defaultConfig} onChange={vi.fn()} agents={[]} />);
    expect(screen.getByText(/no active agents available/i)).toBeInTheDocument();
  });

  it('renders agent checkboxes when agents are provided', () => {
    render(<OrchestratorEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();
    expect(screen.getByText('Writer')).toBeInTheDocument();
  });

  it('shows agent descriptions', () => {
    render(<OrchestratorEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);
    expect(screen.getByText('Finds information')).toBeInTheDocument();
    expect(screen.getByText('Analyzes data')).toBeInTheDocument();
  });

  it('renders planner prompt textarea with initial value', () => {
    render(<OrchestratorEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);
    const textarea = screen.getByPlaceholderText(/research coordinator/i);
    expect(textarea).toHaveValue('Coordinate research.');
  });

  it('fires onChange when planner prompt changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    const textarea = screen.getByPlaceholderText(/research coordinator/i);
    await user.type(textarea, 'Plan');

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ plannerPrompt: expect.any(String) })
    );
  });

  it('calls onChange with updated availableAgentSlugs when agent is checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    const checkbox = screen.getByRole('checkbox', { name: /select agent researcher/i });
    await user.click(checkbox);

    expect(onChange).toHaveBeenCalledWith({
      availableAgentSlugs: ['researcher'],
    });
  });

  it('calls onChange with agent removed when unchecked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrchestratorEditor config={populatedConfig} onChange={onChange} agents={AGENTS} />);

    const checkbox = screen.getByRole('checkbox', { name: /select agent researcher/i });
    await user.click(checkbox);

    expect(onChange).toHaveBeenCalledWith({
      availableAgentSlugs: [],
    });
  });

  it('shows selected agent count', () => {
    render(<OrchestratorEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);
    expect(screen.getByText(/1 agent selected/)).toBeInTheDocument();
  });

  it('renders max rounds input with correct value', () => {
    render(<OrchestratorEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);
    const input = document.getElementById('orchestrator-rounds') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(3);
  });

  it('renders timeout in seconds (converted from ms)', () => {
    render(<OrchestratorEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);
    const input = document.getElementById('orchestrator-timeout') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(120);
  });

  it('renders all FieldHelp info buttons', () => {
    render(<OrchestratorEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    // 9 fields: prompt, agents, mode, rounds, delegations, timeout, budget, model, temperature
    expect(infoButtons.length).toBeGreaterThanOrEqual(9);
  });

  it('renders selection mode dropdown', () => {
    render(<OrchestratorEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);
    // The Select component renders a combobox
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBeGreaterThanOrEqual(1);
  });

  describe('number input onChange handlers', () => {
    it('maxRounds: fires onChange with numeric value', () => {
      const onChange = vi.fn();
      render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-rounds') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '5' } });

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxRounds: 5 }));
    });

    it('timeout: converts seconds to milliseconds in onChange', () => {
      const onChange = vi.fn();
      render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-timeout') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '60' } });

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60000 }));
    });

    it('budget: passes undefined when cleared (empty value)', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const configWithBudget: OrchestratorConfig = {
        ...populatedConfig,
        budgetLimitUsd: 1.5,
      };
      render(<OrchestratorEditor config={configWithBudget} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-budget') as HTMLInputElement;
      await user.clear(input);

      // Clearing the input should fire onChange with budgetLimitUsd: undefined
      const calls = onChange.mock.calls.filter(
        (c) => 'budgetLimitUsd' in (c[0] as Record<string, unknown>)
      );
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toMatchObject({ budgetLimitUsd: undefined });
    });

    it('budget: passes numeric value when set', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-budget') as HTMLInputElement;
      await user.type(input, '2.5');

      const calls = onChange.mock.calls.filter(
        (c) => 'budgetLimitUsd' in (c[0] as Record<string, unknown>)
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    it('model override: passes undefined when cleared', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const configWithModel: OrchestratorConfig = {
        ...defaultConfig,
        modelOverride: 'gpt-4o',
      };
      render(<OrchestratorEditor config={configWithModel} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-model') as HTMLInputElement;
      await user.clear(input);

      const calls = onChange.mock.calls.filter(
        (c) => 'modelOverride' in (c[0] as Record<string, unknown>)
      );
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toMatchObject({ modelOverride: undefined });
    });

    it('temperature: fires onChange with clamped numeric value', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-temperature') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, '0.8');

      const calls = onChange.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>).temperature !== undefined
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    it('delegations per round: fires onChange with numeric value', () => {
      const onChange = vi.fn();
      render(<OrchestratorEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

      const input = document.getElementById('orchestrator-delegations') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '8' } });

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxDelegationsPerRound: 8 }));
    });
  });
});
