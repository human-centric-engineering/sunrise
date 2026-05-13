/**
 * MultiSelect — popover-based multi-pick control.
 *
 * Tests target the recently-added behaviours:
 *   - "Done" footer button closes the popover (both with and without selection)
 *   - Inline-create form: with `createSupportsDescription`, the "+ Create" row
 *     expands into a name + description form rather than firing onCreate
 *     immediately. Description is forwarded as the second argument.
 *   - Without `createSupportsDescription`, clicking "+ Create" fires onCreate
 *     immediately (legacy path).
 *
 * Radix's Popover renders portal content into the same DOM tree under jsdom,
 * so `screen.getByText` reaches it without a portal-specific wrapper.
 *
 * @see components/ui/multi-select.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

function Harness(props: {
  initialValue?: string[];
  options: MultiSelectOption[];
  onCreate?: (label: string, description?: string) => Promise<MultiSelectOption>;
  createSupportsDescription?: boolean;
}) {
  const [value, setValue] = useState(props.initialValue ?? []);
  return (
    <MultiSelect
      value={value}
      onChange={setValue}
      options={props.options}
      {...(props.onCreate ? { onCreate: props.onCreate } : {})}
      {...(props.createSupportsDescription ? { createSupportsDescription: true } : {})}
    />
  );
}

describe('MultiSelect', () => {
  const options: MultiSelectOption[] = [
    { value: 'a', label: 'Alpha', description: 'first letter' },
    { value: 'b', label: 'Beta' },
  ];

  it('renders a Done button that closes the popover when nothing is selected', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} />);

    await user.click(screen.getByRole('combobox'));
    // Footer says "None selected" alongside the Done button before any pick.
    expect(screen.getByText('None selected')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    await user.click(done);

    // Popover closed → footer markers disappear.
    expect(screen.queryByText('None selected')).not.toBeInTheDocument();
  });

  it('shows Done alongside Clear all once items are selected', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} />);

    await user.click(screen.getByRole('combobox'));
    // Click the option's row (the <label>) — the checkbox sits inside it.
    await user.click(screen.getByText('Alpha'));

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('inline-create without description fires onCreate immediately', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ value: 'g', label: 'Gamma' });
    render(<Harness options={options} onCreate={onCreate} />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'Gamma');

    await user.click(screen.getByRole('button', { name: /create "gamma"/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    // No description forwarded — the second arg is undefined.
    expect(onCreate).toHaveBeenCalledWith('Gamma', undefined);
  });

  it('inline-create with description opens an inline form and forwards the description', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockResolvedValue({ value: 'g', label: 'Gamma', description: 'green-tier docs' });
    render(<Harness options={options} onCreate={onCreate} createSupportsDescription />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'Gamma');

    // First click: opens the inline form, does NOT fire onCreate yet.
    await user.click(screen.getByRole('button', { name: /create "gamma"/i }));
    expect(onCreate).not.toHaveBeenCalled();

    // The description input is now visible.
    const descInput = screen.getByLabelText('Description (optional)');
    await user.type(descInput, 'green-tier docs');

    // The Create button (inside the inline form) submits.
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Gamma', 'green-tier docs');
  });

  it('inline-create with description omits the description arg when blank', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ value: 'g', label: 'Gamma' });
    render(<Harness options={options} onCreate={onCreate} createSupportsDescription />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'Gamma');
    await user.click(screen.getByRole('button', { name: /create "gamma"/i }));

    // Leave description blank, click Create.
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith('Gamma', undefined);
  });

  it('Cancel collapses the inline-create form and clears the description', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ value: 'g', label: 'Gamma' });
    render(<Harness options={options} onCreate={onCreate} createSupportsDescription />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'Gamma');
    await user.click(screen.getByRole('button', { name: /create "gamma"/i }));
    await user.type(screen.getByLabelText('Description (optional)'), 'wip');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Description (optional)')).not.toBeInTheDocument();
    // The "+ Create" trigger row is back.
    expect(screen.getByRole('button', { name: /create "gamma"/i })).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
