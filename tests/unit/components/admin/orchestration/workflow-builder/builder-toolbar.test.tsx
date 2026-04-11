/**
 * Unit Tests: BuilderToolbar
 *
 * Test Coverage:
 * - Name input reflects workflowName prop
 * - Typing in name input calls onNameChange
 * - Clicking Validate fires onValidate
 * - Clicking Save fires onSave
 * - saving=true renders a spinner and disables the Save button
 * - hasErrors=true applies the red ring class to the Save button
 * - Execute button is always disabled (available in Session 5.2)
 * - mode="create" shows "Create workflow" text on Save button
 * - mode="edit" shows "Save changes" text on Save button
 * - "Use template" dropdown opens and shows disabled placeholder item
 * - Back navigation link is present
 *
 * @see components/admin/orchestration/workflow-builder/builder-toolbar.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BuilderToolbar } from '@/components/admin/orchestration/workflow-builder/builder-toolbar';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderToolbar(overrides: Partial<Parameters<typeof BuilderToolbar>[0]> = {}) {
  const defaults = {
    workflowName: 'Test',
    onNameChange: vi.fn(),
    mode: 'create' as const,
    onValidate: vi.fn(),
    onSave: vi.fn(),
    saving: false,
    hasErrors: false,
    ...overrides,
  };
  return render(<BuilderToolbar {...defaults} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BuilderToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('name input', () => {
    it('reflects the workflowName prop as the input value', () => {
      renderToolbar({ workflowName: 'My Workflow' });
      const input = screen.getByRole('textbox', { name: /workflow name/i });
      expect((input as HTMLInputElement).value).toBe('My Workflow');
    });

    it('calls onNameChange when the user types in the name input', async () => {
      const user = userEvent.setup();
      const onNameChange = vi.fn();
      renderToolbar({ workflowName: 'Old name', onNameChange });

      const input = screen.getByRole('textbox', { name: /workflow name/i });
      await user.clear(input);
      await user.type(input, 'New name');

      expect(onNameChange).toHaveBeenCalled();
    });
  });

  describe('Validate button', () => {
    it('fires onValidate when clicked', async () => {
      const user = userEvent.setup();
      const onValidate = vi.fn();
      renderToolbar({ onValidate });

      await user.click(screen.getByRole('button', { name: /validate/i }));

      expect(onValidate).toHaveBeenCalledTimes(1);
    });

    it('Validate button is enabled', () => {
      renderToolbar();
      const validateBtn = screen.getByRole('button', { name: /validate/i });
      expect(validateBtn).not.toBeDisabled();
    });
  });

  describe('Save button', () => {
    it('fires onSave when clicked', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderToolbar({ onSave });

      await user.click(screen.getByRole('button', { name: /create workflow/i }));

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('is disabled when saving=true', () => {
      renderToolbar({ saving: true });
      const saveBtn = screen.getByRole('button', { name: /create workflow/i });
      expect(saveBtn).toBeDisabled();
    });

    it('renders a spinner when saving=true', () => {
      // The Loader2 icon is rendered as an SVG inside the button when saving
      renderToolbar({ saving: true });
      // The button text should still be visible
      expect(screen.getByRole('button', { name: /create workflow/i })).toBeInTheDocument();
      // There should be an svg for the spinner
      const saveBtn = screen.getByRole('button', { name: /create workflow/i });
      expect(saveBtn.querySelector('svg')).toBeInTheDocument();
    });

    it('applies the red-ring class when hasErrors=true', () => {
      renderToolbar({ hasErrors: true });
      const saveBtn = screen.getByRole('button', { name: /create workflow/i });
      expect(saveBtn.className).toContain('ring-red');
    });

    it('does NOT apply the red-ring class when hasErrors=false', () => {
      renderToolbar({ hasErrors: false });
      const saveBtn = screen.getByRole('button', { name: /create workflow/i });
      expect(saveBtn.className).not.toContain('ring-red');
    });
  });

  describe('Execute button', () => {
    it('Execute button is always disabled', () => {
      renderToolbar();
      expect(screen.getByRole('button', { name: /execute/i })).toBeDisabled();
    });
  });

  describe('mode prop', () => {
    it('shows "Create workflow" in mode="create"', () => {
      renderToolbar({ mode: 'create' });
      expect(screen.getByRole('button', { name: /create workflow/i })).toBeInTheDocument();
    });

    it('shows "Save changes" in mode="edit"', () => {
      renderToolbar({ mode: 'edit' });
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  describe('Use template dropdown', () => {
    it('renders the Use template trigger button', () => {
      renderToolbar();
      expect(screen.getByRole('button', { name: /use template/i })).toBeInTheDocument();
    });

    it('opens dropdown and shows the stub disabled item on click', async () => {
      const user = userEvent.setup();
      renderToolbar();

      await user.click(screen.getByRole('button', { name: /use template/i }));

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
      renderToolbar();
      const backLink = screen.getByRole('link', { name: /workflows/i });
      expect(backLink).toBeInTheDocument();
    });
  });
});
