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

  it('shows the placeholder text when no items are selected', () => {
    render(<Harness options={options} />);
    expect(screen.getByText('Select…')).toBeInTheDocument();
  });

  it('uses a custom placeholder prop', () => {
    const [value, setValue] = [[] as string[], vi.fn()];
    render(
      <MultiSelect value={value} onChange={setValue} options={options} placeholder="Pick tags…" />
    );
    expect(screen.getByText('Pick tags…')).toBeInTheDocument();
  });

  it('shows emptyText when filter matches nothing', async () => {
    const user = userEvent.setup();
    render(
      <MultiSelect value={[]} onChange={vi.fn()} options={options} emptyText="Nothing found" />
    );
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'zzz');
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('filters options by label substring', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'alp');

    // Only Alpha should be visible; Beta should be gone
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('filters options by description substring', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} />);

    await user.click(screen.getByRole('combobox'));
    // 'first letter' is the description of Alpha
    await user.type(screen.getByLabelText('Search options'), 'first');

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('Clear all removes all selections and resets the footer', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} initialValue={['a', 'b']} />);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByText('None selected')).toBeInTheDocument();
  });

  it('removes a chip via the X button without opening the popover', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} initialValue={['a']} />);

    // Popover is closed; the chip Remove button is on the trigger
    const removeBtn = screen.getByRole('button', { name: 'Remove Alpha' });
    await user.click(removeBtn);

    // Chip gone — placeholder reappears
    expect(screen.getByText('Select…')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('removes a chip via keyboard Enter on the X span', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} initialValue={['a']} />);

    const removeSpan = screen.getByRole('button', { name: 'Remove Alpha' });
    removeSpan.focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('removes a chip via keyboard Space on the X span', async () => {
    const user = userEvent.setup();
    render(<Harness options={options} initialValue={['a']} />);

    const removeSpan = screen.getByRole('button', { name: 'Remove Alpha' });
    removeSpan.focus();
    await user.keyboard(' ');

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('collapses extra chips into "+N more" badge beyond maxVisibleChips', () => {
    const manyOptions: MultiSelectOption[] = Array.from({ length: 8 }, (_, i) => ({
      value: `v${i}`,
      label: `Item ${i}`,
    }));
    // Select all 8 but default maxVisibleChips is 6 → 2 hidden
    render(
      <MultiSelect
        value={manyOptions.map((o) => o.value)}
        onChange={vi.fn()}
        options={manyOptions}
      />
    );
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('submits the inline-create form via Enter key in the description input', async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockResolvedValue({ value: 'g', label: 'Gamma', description: 'keyboard submit' });
    render(<Harness options={options} onCreate={onCreate} createSupportsDescription />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByLabelText('Search options'), 'Gamma');
    await user.click(screen.getByRole('button', { name: /create "gamma"/i }));
    await user.type(screen.getByLabelText('Description (optional)'), 'keyboard submit');
    // Press Enter inside the description field — should submit the form
    await user.keyboard('{Enter}');

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Gamma', 'keyboard submit');
  });

  it('does not show the Create row when query matches an existing option exactly', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness options={options} onCreate={onCreate} />);

    await user.click(screen.getByRole('combobox'));
    // Exact match (case-insensitive) with existing option 'Alpha'
    await user.type(screen.getByLabelText('Search options'), 'Alpha');

    // The create row must not appear — exact label match suppresses it
    expect(screen.queryByRole('button', { name: /create "alpha"/i })).not.toBeInTheDocument();
  });
});

// ─── Async mode ───────────────────────────────────────────────────────────────

describe('MultiSelect — async mode', () => {
  it('calls loadOptions with the search query after debounce and renders results', async () => {
    const user = userEvent.setup();
    const asyncOptions: MultiSelectOption[] = [{ value: 'x', label: 'Extra option' }];
    const loadOptions = vi.fn().mockResolvedValue(asyncOptions);

    render(
      <MultiSelect value={[]} onChange={vi.fn()} loadOptions={loadOptions} selectedLabels={{}} />
    );

    await user.click(screen.getByRole('combobox'));
    // loadOptions is called once on open with empty query
    await screen.findByText('Extra option');

    expect(loadOptions).toHaveBeenCalledWith('');
    expect(screen.getByText('Extra option')).toBeInTheDocument();
  });

  it('shows Loading… while async fetch is in flight', async () => {
    const user = userEvent.setup();
    // Never resolves — keeps the loading state
    const loadOptions = vi.fn().mockReturnValue(new Promise(() => {}));

    render(
      <MultiSelect value={[]} onChange={vi.fn()} loadOptions={loadOptions} selectedLabels={{}} />
    );

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('re-fetches when the search query changes', async () => {
    const user = userEvent.setup();
    const loadOptions = vi
      .fn()
      .mockResolvedValueOnce([{ value: 'x', label: 'Extra' }])
      .mockResolvedValueOnce([{ value: 'y', label: 'Why' }]);

    render(
      <MultiSelect value={[]} onChange={vi.fn()} loadOptions={loadOptions} selectedLabels={{}} />
    );

    await user.click(screen.getByRole('combobox'));
    await screen.findByText('Extra');

    await user.type(screen.getByLabelText('Search options'), 'w');
    await screen.findByText('Why');

    // Called at least twice (initial open + after typing)
    expect(loadOptions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses selectedLabels for chips not in the current async results', async () => {
    // An already-selected value whose label is not in the current async result
    // set should still render the chip using the selectedLabels map.
    const loadOptions = vi.fn().mockResolvedValue([]);

    render(
      <MultiSelect
        value={['z']}
        onChange={vi.fn()}
        loadOptions={loadOptions}
        selectedLabels={{ z: 'Zeta label' }}
      />
    );

    // The chip should say "Zeta label" even though loadOptions returns []
    expect(screen.getByText('Zeta label')).toBeInTheDocument();
  });
});
