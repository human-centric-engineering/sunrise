// @vitest-environment happy-dom

/**
 * Unit Tests: JudgeCallEditor
 *
 * Mirrors the evaluate-editor test shape — render checks, callback
 * shapes, and FieldHelp presence. The component is a pure controlled
 * form; assertions are deliberately structural rather than copy-based.
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/judge-call-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { JudgeCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/judge-call-editor';
import type { JudgeCallConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/judge-call-editor';

const emptyConfig: JudgeCallConfig = { judgeAgentSlug: '', question: '', answer: '' };

describe('JudgeCallEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders without crashing', () => {
    render(<JudgeCallEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('judge-call-agent-slug')).toBeInTheDocument();
  });

  it('renders inputs for judgeAgentSlug, question, answer, expectedOutput, threshold', () => {
    render(<JudgeCallEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('judge-call-agent-slug')).toBeInTheDocument();
    expect(document.getElementById('judge-call-question')).toBeInTheDocument();
    expect(document.getElementById('judge-call-answer')).toBeInTheDocument();
    expect(document.getElementById('judge-call-expected')).toBeInTheDocument();
    expect(document.getElementById('judge-call-threshold')).toBeInTheDocument();
  });

  it('shows the provided judgeAgentSlug', () => {
    const config: JudgeCallConfig = {
      ...emptyConfig,
      judgeAgentSlug: 'eval-judge-correctness',
    };
    render(<JudgeCallEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('judge-call-agent-slug') as HTMLInputElement;
    expect(input.value).toBe('eval-judge-correctness');
  });

  it('shows the provided question and answer templates', () => {
    const config: JudgeCallConfig = {
      ...emptyConfig,
      question: '{{input}}',
      answer: '{{previous.output}}',
    };
    render(<JudgeCallEditor config={config} onChange={vi.fn()} />);
    expect((document.getElementById('judge-call-question') as HTMLTextAreaElement).value).toBe(
      '{{input}}'
    );
    expect((document.getElementById('judge-call-answer') as HTMLTextAreaElement).value).toBe(
      '{{previous.output}}'
    );
  });

  it('shows an empty threshold input when threshold is not set', () => {
    render(<JudgeCallEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('judge-call-threshold') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('shows the provided threshold value', () => {
    const config: JudgeCallConfig = { ...emptyConfig, threshold: 0.7 };
    render(<JudgeCallEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('judge-call-threshold') as HTMLInputElement;
    expect(Number(input.value)).toBeCloseTo(0.7);
  });

  it('renders FieldHelp info buttons for every field', () => {
    render(<JudgeCallEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    // 5 FieldHelp slots: agent slug, question, answer, expected output, threshold.
    expect(infoButtons.length).toBeGreaterThanOrEqual(5);
  });

  // ── Callbacks ───────────────────────────────────────────────────────────────

  it('calls onChange with { judgeAgentSlug } when typing in the slug input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JudgeCallEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('judge-call-agent-slug')!, 'e');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('judgeAgentSlug');
    expect(typeof lastArg.judgeAgentSlug).toBe('string');
  });

  it('calls onChange with { question } when typing in the question textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JudgeCallEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('judge-call-question')!, 'q');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('question');
  });

  it('calls onChange with { answer } when typing in the answer textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JudgeCallEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('judge-call-answer')!, 'a');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('answer');
  });

  it('calls onChange with { expectedOutput } when typing in the expected textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JudgeCallEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('judge-call-expected')!, 'x');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('expectedOutput');
    expect(lastArg.expectedOutput).toBe('x');
  });

  it('calls onChange with { expectedOutput: undefined } when expected textarea is cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: JudgeCallConfig = { ...emptyConfig, expectedOutput: 'ref' };
    render(<JudgeCallEditor config={config} onChange={onChange} />);

    await user.clear(document.getElementById('judge-call-expected')!);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('expectedOutput');
    expect(lastArg.expectedOutput).toBeUndefined();
  });

  it('calls onChange with { threshold: number } when a numeric threshold is entered', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JudgeCallEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('judge-call-threshold')!, '0.7');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('threshold');
    expect(typeof lastArg.threshold).toBe('number');
  });

  it('calls onChange with { threshold: undefined } when threshold input is cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: JudgeCallConfig = { ...emptyConfig, threshold: 0.7 };
    render(<JudgeCallEditor config={config} onChange={onChange} />);

    await user.clear(document.getElementById('judge-call-threshold')!);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('threshold');
    expect(lastArg.threshold).toBeUndefined();
  });

  // ── Defensive defaults when config fields are undefined ───────────────────

  it('renders empty strings for inputs when config fields are undefined (??-fallback path)', () => {
    // Cast through `unknown` so we can pass a partially-formed config —
    // the editor must not blow up if a workflow snapshot omits these
    // fields (e.g. on an older schema).
    const sparseConfig = {} as unknown as JudgeCallConfig;
    render(<JudgeCallEditor config={sparseConfig} onChange={vi.fn()} />);

    expect((document.getElementById('judge-call-agent-slug') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('judge-call-question') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('judge-call-answer') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('judge-call-expected') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('judge-call-threshold') as HTMLInputElement).value).toBe('');
  });
});
