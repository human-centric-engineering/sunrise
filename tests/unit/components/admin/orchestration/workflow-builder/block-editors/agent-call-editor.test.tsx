/**
 * Unit Tests: AgentCallEditor
 *
 * Test Coverage:
 * - Empty agents list renders "No active agents available" message
 * - Renders Select trigger when agents are provided
 * - Selecting an agent calls onChange({ agentSlug })
 * - Message textarea fires onChange({ message })
 * - Conversation mode defaults to 'single-turn'
 * - maxTurns input only visible when mode='multi-turn'
 * - maxToolIterations clamped to 0–20
 * - maxTurns clamped to 1–10
 * - FieldHelp info buttons are rendered
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/agent-call-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/agent-call-editor';
import type { AgentCallConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/agent-call-editor';
import type { AgentOption } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENTS: AgentOption[] = [
  { slug: 'researcher', name: 'Researcher', description: 'Finds information' },
  { slug: 'analyst', name: 'Analyst', description: 'Analyzes data' },
  { slug: 'writer', name: 'Writer', description: null },
];

const defaultConfig: AgentCallConfig = {
  agentSlug: '',
  message: '',
};

const populatedConfig: AgentCallConfig = {
  agentSlug: 'researcher',
  message: '{{input}}',
  maxToolIterations: 5,
  mode: 'single-turn',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentCallEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Empty agents list ────────────────────────────────────────────────────────

  it('renders the "No active agents available" message when agents is empty', () => {
    // Arrange
    render(<AgentCallEditor config={defaultConfig} onChange={vi.fn()} agents={[]} />);

    // Assert: the empty-state message is shown and the agent-slug select trigger is absent.
    // Note: the conversation-mode Select is always rendered, so a combobox is still present —
    // we confirm the agent-slug one specifically is gone by checking its id.
    expect(screen.getByText(/no active agents available/i)).toBeInTheDocument();
    expect(document.getElementById('agent-call-slug')).toBeNull();
  });

  // ── Agent select ─────────────────────────────────────────────────────────────

  it('renders a combobox select trigger when agents are provided', () => {
    // Arrange
    render(<AgentCallEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: at least the agent-slug combobox is rendered (mode select also renders one)
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onChange with { agentSlug } when an agent is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act: open the agent select (first combobox) and pick "Researcher"
    const [agentSelect] = screen.getAllByRole('combobox');
    await user.click(agentSelect);
    const option = await screen.findByRole('option', { name: /researcher/i });
    await user.click(option);

    // Assert: onChange called with the selected slug — the editor computed this from the option click
    expect(onChange).toHaveBeenCalledWith({ agentSlug: 'researcher' });
  });

  it('renders agent names including description suffix', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<AgentCallEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Act: open the agent select to reveal options
    const [agentSelect] = screen.getAllByRole('combobox');
    await user.click(agentSelect);

    // Assert: options contain name + description concatenated by the component
    expect(
      await screen.findByRole('option', { name: /researcher — finds information/i })
    ).toBeInTheDocument();
    // Agent with null description should show name only
    expect(await screen.findByRole('option', { name: /^writer$/i })).toBeInTheDocument();
  });

  // ── Message textarea ─────────────────────────────────────────────────────────

  it('renders the message textarea with the configured value', () => {
    // Arrange
    render(<AgentCallEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: textarea reflects the config value
    expect(screen.getByRole('textbox')).toHaveValue('{{input}}');
  });

  it('calls onChange with { message } when textarea value changes', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act: type into the message textarea
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello');

    // Assert: onChange was called with the message key — typed characters trigger this
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  // ── Conversation mode select ─────────────────────────────────────────────────

  it('mode select defaults to single-turn when mode is not set in config', () => {
    // Arrange: config without explicit mode
    render(<AgentCallEditor config={defaultConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: the mode combobox displays "Single-turn"
    expect(screen.getByText('Single-turn')).toBeInTheDocument();
  });

  it('calls onChange with { mode } when a conversation mode is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act: open the mode select (last combobox) and pick "Multi-turn"
    const comboboxes = screen.getAllByRole('combobox');
    const modeSelect = comboboxes[comboboxes.length - 1];
    await user.click(modeSelect);
    const option = await screen.findByRole('option', { name: /multi-turn/i });
    await user.click(option);

    // Assert: onChange called with the mode the component derived from the selection
    expect(onChange).toHaveBeenCalledWith({ mode: 'multi-turn' });
  });

  // ── maxTurns visibility ──────────────────────────────────────────────────────

  it('does NOT render the maxTurns input when mode is single-turn', () => {
    // Arrange: single-turn config
    render(<AgentCallEditor config={populatedConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: max turns input is absent
    expect(document.getElementById('agent-call-max-turns')).toBeNull();
  });

  it('renders the maxTurns input when mode is multi-turn', () => {
    // Arrange: multi-turn config
    const multiTurnConfig: AgentCallConfig = { ...defaultConfig, mode: 'multi-turn' };
    render(<AgentCallEditor config={multiTurnConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: max turns input is present
    expect(document.getElementById('agent-call-max-turns')).toBeInTheDocument();
  });

  // ── maxToolIterations clamping ───────────────────────────────────────────────

  it('clamps maxToolIterations to max 20 when a value above the ceiling is entered', () => {
    // Arrange
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act: fire a change event with a value above the maximum
    const input = document.getElementById('agent-call-tool-iterations') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });

    // Assert: onChange is called with the clamped value, not the raw input
    expect(onChange).toHaveBeenCalledWith({ maxToolIterations: 20 });
  });

  it('clamps maxToolIterations to min 0 when a negative value is entered', () => {
    // Arrange
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act: fire a change event with a negative value
    const input = document.getElementById('agent-call-tool-iterations') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-5' } });

    // Assert: onChange is called with the clamped value of 0
    expect(onChange).toHaveBeenCalledWith({ maxToolIterations: 0 });
  });

  it('passes through a valid maxToolIterations value within 0–20 without clamping', () => {
    // Arrange
    const onChange = vi.fn();
    render(<AgentCallEditor config={defaultConfig} onChange={onChange} agents={AGENTS} />);

    // Act
    const input = document.getElementById('agent-call-tool-iterations') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } });

    // Assert: value is passed as-is since it is within range
    expect(onChange).toHaveBeenCalledWith({ maxToolIterations: 10 });
  });

  // ── maxTurns clamping ────────────────────────────────────────────────────────

  it('clamps maxTurns to max 10 when a value above the ceiling is entered', () => {
    // Arrange: multi-turn mode so the input is rendered
    const onChange = vi.fn();
    const multiTurnConfig: AgentCallConfig = { ...defaultConfig, mode: 'multi-turn' };
    render(<AgentCallEditor config={multiTurnConfig} onChange={onChange} agents={AGENTS} />);

    // Act
    const input = document.getElementById('agent-call-max-turns') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50' } });

    // Assert: clamped to 10
    expect(onChange).toHaveBeenCalledWith({ maxTurns: 10 });
  });

  it('clamps maxTurns to min 1 when a value below the floor is entered', () => {
    // Arrange
    const onChange = vi.fn();
    const multiTurnConfig: AgentCallConfig = { ...defaultConfig, mode: 'multi-turn' };
    render(<AgentCallEditor config={multiTurnConfig} onChange={onChange} agents={AGENTS} />);

    // Act
    const input = document.getElementById('agent-call-max-turns') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });

    // Assert: clamped to 1
    expect(onChange).toHaveBeenCalledWith({ maxTurns: 1 });
  });

  // ── FieldHelp buttons ────────────────────────────────────────────────────────

  it('renders FieldHelp info buttons for each documented field', () => {
    // Arrange: multi-turn so maxTurns FieldHelp is also present
    const multiTurnConfig: AgentCallConfig = { ...defaultConfig, mode: 'multi-turn' };
    render(<AgentCallEditor config={multiTurnConfig} onChange={vi.fn()} agents={AGENTS} />);

    // Assert: agent, message, mode, maxToolIterations, maxTurns → 5 FieldHelp buttons
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(4);
  });
});
