// @vitest-environment happy-dom

/**
 * CaseReviewStep component tests.
 *
 * Coverage:
 *  - Empty / null preview short-circuits to "No proposals."
 *  - Stats strip shows count, cost, tokens
 *  - Editable mode (`onEdit` provided): textareas for input + expectedOutput,
 *    edits flow back through the callback
 *  - Read-only mode (`onEdit` omitted): renders <p>s, no textareas
 *  - Object inputs stay read-only even when editable mode is on
 *
 * @see components/admin/orchestration/evaluations-foundations/case-review-step.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  CaseReviewStep,
  type PreviewResult,
  type ProposedCase,
} from '@/components/admin/orchestration/evaluations-foundations/case-review-step';

function buildPreview(overrides?: Partial<PreviewResult>): PreviewResult {
  return {
    cases: [
      { input: 'What is the refund window?', expectedOutput: '30 days.' },
      { input: 'How do I cancel?', expectedOutput: 'Use the dashboard.' },
    ],
    costUsd: 0.0042,
    tokenUsage: { input: 120, output: 60 },
    ...overrides,
  };
}

describe('CaseReviewStep', () => {
  it('returns the "No proposals." short-circuit when preview is null', () => {
    render(<CaseReviewStep preview={null} selectedIndices={new Set()} toggleSelected={vi.fn()} />);
    expect(screen.getByText(/No proposals\./)).toBeInTheDocument();
  });

  it('renders the stats strip with count, cost, tokens', () => {
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0, 1])}
        toggleSelected={vi.fn()}
      />
    );
    expect(screen.getByText('2 proposals')).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0042 generator cost/)).toBeInTheDocument();
    expect(screen.getByText(/120 in \/ 60 out tokens/)).toBeInTheDocument();
  });

  it('read-only mode (no onEdit) renders <p>s, no textareas', () => {
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0])}
        toggleSelected={vi.fn()}
      />
    );
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByText('What is the refund window?')).toBeInTheDocument();
  });

  it('editable mode (onEdit provided) renders textareas + the editor hint', () => {
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0])}
        toggleSelected={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    expect(
      screen.getByText(/Edit the input or expected output before saving/i)
    ).toBeInTheDocument();
    // 2 cases × 2 fields = 4 textareas.
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('typing into the input textarea fires onEdit with the new value', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0, 1])}
        toggleSelected={vi.fn()}
        onEdit={onEdit}
      />
    );
    // First-row input textarea has id="proposal-0-input"
    const inputBox = document.getElementById('proposal-0-input') as HTMLTextAreaElement;
    await user.type(inputBox, '!');
    // onEdit should have fired with index 0 and a string `input` patch.
    expect(onEdit).toHaveBeenCalled();
    const lastCall = onEdit.mock.calls[onEdit.mock.calls.length - 1];
    expect(lastCall[0]).toBe(0);
    expect(typeof (lastCall[1] as { input?: string }).input).toBe('string');
  });

  it('clearing expectedOutput fires onEdit with undefined', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0])}
        toggleSelected={vi.fn()}
        onEdit={onEdit}
      />
    );
    const expectedBox = document.getElementById('proposal-0-expected') as HTMLTextAreaElement;
    await user.clear(expectedBox);
    expect(onEdit).toHaveBeenCalled();
    const lastCall = onEdit.mock.calls[onEdit.mock.calls.length - 1];
    expect(lastCall[1]).toEqual({ expectedOutput: undefined });
  });

  it('object inputs (workflow subjects) stay read-only even in editable mode', () => {
    const objectInputCase: ProposedCase = {
      input: { topic: 'refund', urgency: 'high' },
      expectedOutput: 'a',
    };
    const preview: PreviewResult = {
      cases: [objectInputCase],
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
    };
    render(
      <CaseReviewStep
        preview={preview}
        selectedIndices={new Set([0])}
        toggleSelected={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    // Only one textarea (the expectedOutput); the object input renders as a <p>.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByText(/"topic":"refund"/)).toBeInTheDocument();
  });

  it('renders the empty-state hint when expectedOutput is missing in read-only mode', () => {
    const preview: PreviewResult = {
      cases: [{ input: 'q' }],
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
    };
    render(
      <CaseReviewStep preview={preview} selectedIndices={new Set([0])} toggleSelected={vi.fn()} />
    );
    expect(screen.getByText(/No expected output\./i)).toBeInTheDocument();
  });

  it('toggling the checkbox fires toggleSelected with the row index', async () => {
    const toggleSelected = vi.fn();
    const user = userEvent.setup();
    render(
      <CaseReviewStep
        preview={buildPreview()}
        selectedIndices={new Set([0])}
        toggleSelected={toggleSelected}
      />
    );
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);
    expect(toggleSelected).toHaveBeenCalledWith(1);
  });
});
