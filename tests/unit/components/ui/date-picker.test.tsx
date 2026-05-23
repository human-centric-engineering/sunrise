/**
 * DatePicker (components/ui/date-picker.tsx) — primitive component tests
 *
 * Drives the public contract:
 * - Renders the placeholder when value is empty
 * - Renders the value as dd/MM/yyyy when set
 * - Opening the popover renders the Calendar grid
 * - Clicking a day calls onChange with a YYYY-MM-DD ISO string
 * - The clear (X) button calls onChange('') and is hidden when no value
 * - Disabled state hides the clear button and disables the trigger
 * - `fromDate` / `toDate` clamp the selectable range (disabled days)
 * - Bad ISO input falls through to placeholder rather than crashing
 *
 * @see components/ui/date-picker.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DatePicker } from '@/components/ui/date-picker';

describe('DatePicker', () => {
  it('shows the placeholder when value is empty', () => {
    render(<DatePicker value="" onChange={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('dd/mm/yyyy');
  });

  it('renders a custom placeholder', () => {
    render(<DatePicker value="" onChange={vi.fn()} placeholder="Pick a day" />);
    expect(screen.getByRole('button')).toHaveTextContent('Pick a day');
  });

  it('formats the value as dd/MM/yyyy when set', () => {
    render(<DatePicker value="2026-01-15" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /clear date/i })).toBeInTheDocument();
    // The trigger label includes the formatted date and the Clear-date sub-button.
    const trigger = screen.getAllByRole('button')[0];
    expect(trigger.textContent).toContain('15/01/2026');
  });

  it('falls back to the placeholder when value is not a valid ISO date', () => {
    render(<DatePicker value="not-a-date" onChange={vi.fn()} />);
    // The trigger button only — no clear-button rendered because selected is undefined.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button')).toHaveTextContent('dd/mm/yyyy');
  });

  it('opens the calendar popover when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<DatePicker value="2026-01-15" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /15\/01\/2026/i }));

    // react-day-picker renders the month grid as <table role="grid">.
    expect(await screen.findByRole('grid')).toBeInTheDocument();
  });

  it('clicking a day fires onChange with a YYYY-MM-DD ISO string', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker value="2026-01-15" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /15\/01\/2026/i }));

    // react-day-picker labels day buttons by full date — e.g.
    // "Tuesday, January 20th, 2026". Match the month + day + year so we don't
    // collide with "2026" in other cells.
    const grid = await screen.findByRole('grid');
    const day20 = within(grid).getByRole('button', { name: /January 20th, 2026/i });
    await user.click(day20);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-01-20');
  });

  it('clear (X) button calls onChange("") and stops propagation', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker value="2026-01-15" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /clear date/i }));

    expect(onChange).toHaveBeenCalledWith('');
    // The popover should NOT open because the X button's onClick stopPropagation
    // prevents the trigger from being activated.
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('clear button is hidden when value is empty', () => {
    render(<DatePicker value="" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /clear date/i })).not.toBeInTheDocument();
  });

  it('disabled prop hides the clear button and disables the trigger', () => {
    render(<DatePicker value="2026-01-15" onChange={vi.fn()} disabled />);
    const trigger = screen.getAllByRole('button')[0];
    expect(trigger).toBeDisabled();
    // When disabled, the inline clear button is not rendered.
    expect(screen.queryByRole('button', { name: /clear date/i })).not.toBeInTheDocument();
  });

  it('clear via Enter key on the X button fires onChange("")', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DatePicker value="2026-01-15" onChange={onChange} />);

    const clearSpan = screen.getByRole('button', { name: /clear date/i });
    clearSpan.focus();
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disables days outside the [fromDate, toDate] range', async () => {
    const user = userEvent.setup();
    render(
      <DatePicker value="2026-01-15" onChange={vi.fn()} fromDate="2026-01-10" toDate="2026-01-20" />
    );

    await user.click(screen.getByRole('button', { name: /15\/01\/2026/i }));

    const grid = await screen.findByRole('grid');
    // 5 is before the fromDate (10) → react-day-picker marks it disabled.
    const day05 = within(grid).getByRole('button', { name: /January 5th, 2026/i });
    expect(day05).toBeDisabled();
    // 15 is inside the range → enabled.
    const day15 = within(grid).getByRole('button', { name: /January 15th, 2026/i });
    expect(day15).not.toBeDisabled();
  });

  it('passes through aria-label / aria-labelledby on the trigger', () => {
    render(
      <DatePicker
        value=""
        onChange={vi.fn()}
        aria-label="Filter from date"
        aria-labelledby="dlq-since-label"
      />
    );
    const trigger = screen.getByRole('button', { name: 'Filter from date' });
    expect(trigger).toHaveAttribute('aria-labelledby', 'dlq-since-label');
  });
});
