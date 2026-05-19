import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ReasoningEffortSelect,
  fromReasoningEffortFormValue,
  toReasoningEffortFormValue,
} from '@/components/admin/orchestration/reasoning-effort-select';

describe('ReasoningEffortSelect helpers', () => {
  describe('toReasoningEffortFormValue', () => {
    it("maps null / undefined / empty-ish values to the 'auto' sentinel", () => {
      expect(toReasoningEffortFormValue(null)).toBe('auto');
      expect(toReasoningEffortFormValue(undefined)).toBe('auto');
      expect(toReasoningEffortFormValue('')).toBe('auto');
    });

    it('passes through the four enum values verbatim', () => {
      expect(toReasoningEffortFormValue('minimal')).toBe('minimal');
      expect(toReasoningEffortFormValue('low')).toBe('low');
      expect(toReasoningEffortFormValue('medium')).toBe('medium');
      expect(toReasoningEffortFormValue('high')).toBe('high');
    });

    it("drops unknown column values to 'auto' rather than narrowing to a wrong enum member", () => {
      // The column is plain TEXT in Postgres — an operator could write
      // garbage via raw SQL. Treat unknown as absent so the runtime
      // falls back to the provider default.
      expect(toReasoningEffortFormValue('banana')).toBe('auto');
    });
  });

  describe('fromReasoningEffortFormValue', () => {
    it("maps the 'auto' sentinel back to null (the column's stored shape)", () => {
      expect(fromReasoningEffortFormValue('auto')).toBeNull();
    });

    it('passes through the four enum values verbatim', () => {
      expect(fromReasoningEffortFormValue('minimal')).toBe('minimal');
      expect(fromReasoningEffortFormValue('low')).toBe('low');
      expect(fromReasoningEffortFormValue('medium')).toBe('medium');
      expect(fromReasoningEffortFormValue('high')).toBe('high');
    });
  });
});

describe('ReasoningEffortSelect component', () => {
  it('renders with the Auto option visible when value is "auto"', () => {
    render(<ReasoningEffortSelect id="test-select" value="auto" onChange={vi.fn()} />);

    const trigger = screen.getByRole('combobox', { name: /reasoning effort/i });
    expect(trigger).toHaveTextContent(/auto/i);
  });

  it('reflects the current value when non-auto is selected', () => {
    render(<ReasoningEffortSelect id="test-select" value="high" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: /reasoning effort/i });
    expect(trigger).toHaveTextContent(/high/i);
  });

  it('honours a custom label (used by panels that override the default)', () => {
    render(
      <ReasoningEffortSelect
        id="orchestrator-select"
        label="Planner reasoning effort"
        value="medium"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: /planner reasoning effort/i })).toBeInTheDocument();
  });

  it('fires onChange with the picked form value when the operator selects an option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReasoningEffortSelect id="rfx-select" value="auto" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: /reasoning effort/i }));
    await user.click(await screen.findByRole('option', { name: /^high$/i }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith('high');
  });
});
