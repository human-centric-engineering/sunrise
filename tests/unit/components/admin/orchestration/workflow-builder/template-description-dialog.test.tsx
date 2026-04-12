/**
 * Unit Tests: TemplateDescriptionDialog
 *
 * Test Coverage:
 *  - Renders the template name, short description, pattern badges, and flow summary
 *  - canvasHasContent=false → confirm button reads "Use this template" (no warning)
 *  - canvasHasContent=true → confirm button reads "Replace canvas with template" and
 *    a warning is shown
 *  - Confirm click fires onConfirm
 *  - Cancel click calls onOpenChange(false)
 *  - template=null → dialog returns null (nothing rendered)
 *
 * @see components/admin/orchestration/workflow-builder/template-description-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TemplateDescriptionDialog } from '@/components/admin/orchestration/workflow-builder/template-description-dialog';
import type { WorkflowTemplate } from '@/lib/orchestration/workflows/templates';

const SAMPLE_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-sample',
  name: 'Sample Template',
  shortDescription: 'A compact sample used by the dialog unit test.',
  patterns: [
    { number: 2, name: 'Routing' },
    { number: 14, name: 'RAG' },
  ],
  flowSummary: 'Route the request and retrieve grounding context before replying.',
  workflowDefinition: {
    entryStepId: 'entry',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'entry',
        name: 'Entry',
        type: 'llm_call',
        config: { prompt: 'Hello', modelOverride: '', temperature: 0.5 },
        nextSteps: [],
      },
    ],
  },
};

function renderDialog(overrides: Partial<Parameters<typeof TemplateDescriptionDialog>[0]> = {}) {
  const defaults = {
    open: true,
    template: SAMPLE_TEMPLATE,
    canvasHasContent: false,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  return render(<TemplateDescriptionDialog {...defaults} />);
}

describe('TemplateDescriptionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders template name, description, and flow summary', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Sample Template')).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_TEMPLATE.shortDescription)).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_TEMPLATE.flowSummary)).toBeInTheDocument();
  });

  it('renders a badge per pattern', () => {
    renderDialog();
    expect(screen.getByText(/#2 Routing/)).toBeInTheDocument();
    expect(screen.getByText(/#14 RAG/)).toBeInTheDocument();
  });

  it('shows "Use this template" confirm copy when the canvas is empty', () => {
    renderDialog({ canvasHasContent: false });
    expect(screen.getByRole('button', { name: /use this template/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows "Replace canvas with template" confirm copy and a warning when canvas has content', () => {
    renderDialog({ canvasHasContent: true });
    expect(
      screen.getByRole('button', { name: /replace canvas with template/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/replace every node and edge/i);
  });

  it('fires onConfirm when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });

    await user.click(screen.getByRole('button', { name: /use this template/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when template is null', () => {
    const { container } = renderDialog({ template: null });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
