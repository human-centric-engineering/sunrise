/**
 * Unit Tests: BuilderToolbar
 *
 * Test Coverage:
 * - Name input reflects workflowName prop
 * - Typing in name input calls onNameChange
 * - Save / Validate / Execute buttons are disabled
 * - mode="create" shows "Create workflow" text on Save button
 * - mode="edit" shows "Save changes" text on Save button
 * - "Use template" dropdown opens and shows disabled placeholder item
 *
 * @see components/admin/orchestration/workflow-builder/builder-toolbar.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BuilderToolbar } from '@/components/admin/orchestration/workflow-builder/builder-toolbar';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BuilderToolbar', () => {
  describe('name input', () => {
    it('reflects the workflowName prop as the input value', () => {
      render(<BuilderToolbar workflowName="My Workflow" onNameChange={vi.fn()} mode="create" />);

      const input = screen.getByRole('textbox', { name: /workflow name/i });
      expect((input as HTMLInputElement).value).toBe('My Workflow');
    });

    it('calls onNameChange when the user types in the name input', async () => {
      const user = userEvent.setup();
      const onNameChange = vi.fn();

      render(<BuilderToolbar workflowName="Old name" onNameChange={onNameChange} mode="create" />);

      const input = screen.getByRole('textbox', { name: /workflow name/i });
      await user.clear(input);
      await user.type(input, 'New name');

      expect(onNameChange).toHaveBeenCalled();
    });
  });

  describe('action buttons are disabled', () => {
    it('Validate button is disabled', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      const validateBtn = screen.getByRole('button', { name: /validate/i });
      expect(validateBtn).toBeDisabled();
    });

    it('Execute button is disabled', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      const executeBtn = screen.getByRole('button', { name: /execute/i });
      expect(executeBtn).toBeDisabled();
    });

    it('Save button is disabled', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      const saveBtn = screen.getByRole('button', { name: /create workflow/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  describe('mode prop', () => {
    it('shows "Create workflow" in mode="create"', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      expect(screen.getByRole('button', { name: /create workflow/i })).toBeInTheDocument();
    });

    it('shows "Save changes" in mode="edit"', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="edit" />);

      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  describe('Use template dropdown', () => {
    it('renders the Use template trigger button', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      expect(screen.getByRole('button', { name: /use template/i })).toBeInTheDocument();
    });

    it('opens dropdown and shows the stub disabled item on click', async () => {
      const user = userEvent.setup();
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      await user.click(screen.getByRole('button', { name: /use template/i }));

      // The disabled item should appear
      const item = await screen.findByRole('menuitem', {
        name: /template loading arrives in session 5\.1c/i,
        hidden: true,
      });
      expect(item).toBeInTheDocument();
      expect(item).toHaveAttribute('data-disabled');
    });
  });

  describe('back navigation', () => {
    it('renders a Workflows back link', () => {
      render(<BuilderToolbar workflowName="Test" onNameChange={vi.fn()} mode="create" />);

      const backLink = screen.getByRole('link', { name: /workflows/i });
      expect(backLink).toBeInTheDocument();
    });
  });
});
