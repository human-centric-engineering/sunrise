/**
 * Unit Tests: Simple block editors (Reflect, RagRetrieve, HumanApproval, Plan)
 *
 * Test Coverage:
 * - Each editor renders with default config
 * - Each editor fires onChange with the right partial on change
 * - FieldHelp popover is present in each editor
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/reflect-editor.tsx
 * @see components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor.tsx
 * @see components/admin/orchestration/workflow-builder/block-editors/human-approval-editor.tsx
 * @see components/admin/orchestration/workflow-builder/block-editors/plan-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReflectEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/reflect-editor';
import type { ReflectConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/reflect-editor';

import { RagRetrieveEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor';
import type { RagRetrieveConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor';

import { HumanApprovalEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/human-approval-editor';
import type { HumanApprovalConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/human-approval-editor';

import { PlanEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/plan-editor';
import type { PlanConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/plan-editor';

// ─── ReflectEditor ────────────────────────────────────────────────────────────

describe('ReflectEditor', () => {
  const emptyConfig: ReflectConfig = { critiquePrompt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('reflect-critique')).toBeInTheDocument();
  });

  it('shows the default maxIterations value of 3', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('reflect-max-iter') as HTMLInputElement;
    expect(Number(input?.value)).toBe(3);
  });

  it('shows a provided critiquePrompt value', () => {
    const config: ReflectConfig = { critiquePrompt: 'Check for errors' };
    render(<ReflectEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('reflect-critique') as HTMLTextAreaElement;
    expect(ta?.value).toBe('Check for errors');
  });

  it('calls onChange with { critiquePrompt } when typing in the critique prompt', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReflectEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('reflect-critique')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('critiquePrompt');
  });

  it('calls onChange with { maxIterations: number } when max iterations changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReflectEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('reflect-max-iter')!;
    await user.clear(input);
    await user.type(input, '5');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('maxIterations');
    expect(typeof lastArg.maxIterations).toBe('number');
  });

  it('renders at least one FieldHelp info button', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── Model override field ─────────────────────────────────────────────────

  it('renders the model override input', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('reflect-model-override')).toBeInTheDocument();
  });

  it('shows the provided modelOverride value', () => {
    const config: ReflectConfig = { critiquePrompt: '', modelOverride: 'claude-haiku-4-5' };
    render(<ReflectEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('reflect-model-override') as HTMLInputElement;
    expect(input.value).toBe('claude-haiku-4-5');
  });

  it('calls onChange with { modelOverride: string } when the model override field is filled', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReflectEditor config={emptyConfig} onChange={onChange} />);

    // Act — type a single character so the controlled component emits one onChange call
    await user.type(document.getElementById('reflect-model-override')!, 'x');

    // Assert — onChange was called with the modelOverride key populated
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ modelOverride: expect.anything() })
    );
  });

  it('calls onChange with { modelOverride: undefined } when the model override field is cleared', async () => {
    // Arrange — start with a non-empty override so clearing it has effect
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: ReflectConfig = { critiquePrompt: '', modelOverride: 'abc' };
    render(<ReflectEditor config={config} onChange={onChange} />);

    // Act — clear the field (e.target.value becomes '', so onChange fires with `undefined`)
    await user.clear(document.getElementById('reflect-model-override')!);

    // Assert — the handler maps empty string to undefined
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('modelOverride');
    expect(lastArg.modelOverride).toBeUndefined();
  });

  // ── Temperature field ────────────────────────────────────────────────────

  it('renders the temperature input', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('reflect-temperature')).toBeInTheDocument();
  });

  it('shows the default temperature value of 0.3 when not provided', () => {
    render(<ReflectEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('reflect-temperature') as HTMLInputElement;
    expect(Number(input.value)).toBe(0.3);
  });

  it('shows a provided temperature value', () => {
    const config: ReflectConfig = { critiquePrompt: '', temperature: 0.8 };
    render(<ReflectEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('reflect-temperature') as HTMLInputElement;
    expect(Number(input.value)).toBe(0.8);
  });

  it('calls onChange with { temperature: number } when temperature input changes', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReflectEditor config={emptyConfig} onChange={onChange} />);

    // Act
    const input = document.getElementById('reflect-temperature')!;
    await user.clear(input);
    await user.type(input, '0.5');

    // Assert — onChange was called with a numeric temperature
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('temperature');
    expect(typeof lastArg.temperature).toBe('number');
  });
});

// ─── RagRetrieveEditor ────────────────────────────────────────────────────────

describe('RagRetrieveEditor', () => {
  const emptyConfig: RagRetrieveConfig = { query: '' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('rag-query')).toBeInTheDocument();
  });

  it('shows the default topK value of 5', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('rag-top-k') as HTMLInputElement;
    expect(Number(input?.value)).toBe(5);
  });

  it('shows the default similarityThreshold value of 0.7', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('rag-threshold') as HTMLInputElement;
    expect(Number(input?.value)).toBe(0.7);
  });

  it('calls onChange with { query } when typing in the query field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RagRetrieveEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('rag-query')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('query');
  });

  it('calls onChange with { topK: number } when result count changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RagRetrieveEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('rag-top-k')!;
    await user.clear(input);
    await user.type(input, '10');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('topK');
    expect(typeof lastArg.topK).toBe('number');
  });

  it('renders at least one FieldHelp info button', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── HumanApprovalEditor ──────────────────────────────────────────────────────

describe('HumanApprovalEditor', () => {
  const emptyConfig: HumanApprovalConfig = { prompt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('approval-prompt')).toBeInTheDocument();
  });

  it('shows the default timeoutMinutes value of 60', () => {
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('approval-timeout') as HTMLInputElement;
    expect(Number(input?.value)).toBe(60);
  });

  it('shows a provided prompt value', () => {
    const config: HumanApprovalConfig = { prompt: 'Please review' };
    render(<HumanApprovalEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('approval-prompt') as HTMLTextAreaElement;
    expect(ta?.value).toBe('Please review');
  });

  it('calls onChange with { prompt } when typing in the approval message', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HumanApprovalEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('approval-prompt')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('prompt');
  });

  it('shows the default notification channel as In-app', () => {
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(screen.getByText('In-app')).toBeInTheDocument();
  });

  it('renders at least one FieldHelp info button', () => {
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── PlanEditor ───────────────────────────────────────────────────────────────

describe('PlanEditor', () => {
  const emptyConfig: PlanConfig = { objective: '' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('plan-objective')).toBeInTheDocument();
  });

  it('shows the default maxSubSteps value of 5', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('plan-max-substeps') as HTMLInputElement;
    expect(Number(input?.value)).toBe(5);
  });

  it('shows a provided objective value', () => {
    const config: PlanConfig = { objective: 'Migrate database' };
    render(<PlanEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('plan-objective') as HTMLTextAreaElement;
    expect(ta?.value).toBe('Migrate database');
  });

  it('calls onChange with { objective } when typing in objective field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('plan-objective')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('objective');
  });

  it('calls onChange with { maxSubSteps: number } when max sub-steps changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('plan-max-substeps')!;
    await user.clear(input);
    await user.type(input, '8');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('maxSubSteps');
    expect(typeof lastArg.maxSubSteps).toBe('number');
  });

  it('renders at least one FieldHelp info button', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── Model override field ─────────────────────────────────────────────────

  it('renders the model override input', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('plan-model-override')).toBeInTheDocument();
  });

  it('shows the provided modelOverride value', () => {
    const config: PlanConfig = { objective: '', modelOverride: 'claude-haiku-4-5' };
    render(<PlanEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('plan-model-override') as HTMLInputElement;
    expect(input.value).toBe('claude-haiku-4-5');
  });

  it('calls onChange with { modelOverride: string } when user types in the model override field', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanEditor config={emptyConfig} onChange={onChange} />);

    // Act — type a single character; controlled component emits one onChange call
    await user.type(document.getElementById('plan-model-override')!, 'x');

    // Assert — onChange was called with a modelOverride key
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ modelOverride: expect.anything() })
    );
  });

  it('calls onChange with { modelOverride: undefined } when the model override field is cleared', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: PlanConfig = { objective: '', modelOverride: 'abc' };
    render(<PlanEditor config={config} onChange={onChange} />);

    // Act — clearing the field sends empty string; handler maps '' to undefined
    await user.clear(document.getElementById('plan-model-override')!);

    // Assert
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('modelOverride');
    expect(lastArg.modelOverride).toBeUndefined();
  });

  // ── Temperature field ────────────────────────────────────────────────────

  it('renders the temperature input', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('plan-temperature')).toBeInTheDocument();
  });

  it('shows the default temperature value of 0.3 when not provided', () => {
    render(<PlanEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('plan-temperature') as HTMLInputElement;
    expect(Number(input.value)).toBe(0.3);
  });

  it('shows a provided temperature value', () => {
    const config: PlanConfig = { objective: '', temperature: 1.0 };
    render(<PlanEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('plan-temperature') as HTMLInputElement;
    expect(Number(input.value)).toBe(1.0);
  });

  it('calls onChange with { temperature: number } when temperature input changes', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanEditor config={emptyConfig} onChange={onChange} />);

    // Act
    const input = document.getElementById('plan-temperature')!;
    await user.clear(input);
    await user.type(input, '0.6');

    // Assert — onChange fired with a numeric temperature
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('temperature');
    expect(typeof lastArg.temperature).toBe('number');
  });
});
