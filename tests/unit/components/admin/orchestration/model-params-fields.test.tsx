// @vitest-environment happy-dom

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ModelParamsFields,
  parseStopSequences,
  type ModelParamsValue,
} from '@/components/admin/orchestration/model-params-fields';

const EMPTY: ModelParamsValue = {
  stopSequences: [],
  topP: null,
  verbosity: null,
  parallelToolCalls: null,
  serviceTier: null,
};

/** Holds the value the way a form does, so typing goes round the loop. */
function Harness({ onChange }: { onChange: (patch: Partial<ModelParamsValue>) => void }) {
  const [value, setValue] = useState(EMPTY);
  return (
    <ModelParamsFields
      idPrefix="t"
      value={value}
      onChange={(patch) => {
        setValue((v) => ({ ...v, ...patch }));
        onChange(patch);
      }}
    />
  );
}

describe('parseStopSequences', () => {
  it('reads one sequence per line, skipping blanks, at most four', () => {
    expect(parseStopSequences('END\n\n###\na\nb\nc')).toEqual(['END', '###', 'a', 'b']);
  });
});

describe('ModelParamsFields', () => {
  it('sends each stop sequence typed on its own line, keeping the line being started', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const box = screen.getByRole('textbox', { name: /stop sequences/i });
    await user.type(box, 'END{Enter}###');

    expect(box).toHaveValue('END\n###');
    expect(onChange).toHaveBeenLastCalledWith({ stopSequences: ['END', '###'] });
  });

  it('sends top P as a number and an empty box as null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole('spinbutton', { name: /top p/i });
    await user.type(input, '0.5');
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.5 });
    await user.clear(input);
    expect(onChange).toHaveBeenLastCalledWith({ topP: null });
  });

  it('sends false when tool calls are limited to one at a time', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: /parallel tool calls/i }));
    await user.click(await screen.findByRole('option', { name: 'One at a time' }));

    expect(onChange).toHaveBeenLastCalledWith({ parallelToolCalls: false });
  });

  it('sends the picked service tier, and null for the provider default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: /service tier/i });
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: /^flex/i }));
    expect(onChange).toHaveBeenLastCalledWith({ serviceTier: 'flex' });

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Provider default' }));
    expect(onChange).toHaveBeenLastCalledWith({ serviceTier: null });
  });

  it('shows a stored list the parser would change once, without looping', () => {
    // A blank entry from raw SQL or a fork's bundle used to reset the box on
    // every render ("Too many re-renders").
    render(
      <ModelParamsFields
        idPrefix="t"
        value={{ ...EMPTY, stopSequences: ['a', '', 'b'] }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole('textbox', { name: /stop sequences/i })).toHaveValue('a\n\nb');
  });

  it('says when more than four sequences are typed, and sends the first four', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.type(
      screen.getByRole('textbox', { name: /stop sequences/i }),
      'a{Enter}b{Enter}c{Enter}d{Enter}e'
    );

    expect(
      screen.getByText(/only the first 4 lines are used\. the last 1 will be ignored/i)
    ).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({ stopSequences: ['a', 'b', 'c', 'd'] });
  });

  it('says when top P is outside 0–1, rather than changing what was typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.type(screen.getByRole('spinbutton', { name: /top p/i }), '5');

    expect(onChange).toHaveBeenLastCalledWith({ topP: 5 });
    expect(screen.getByText('Top P must be between 0 and 1.')).toBeInTheDocument();
  });

  it('shows a locked field read-only', () => {
    render(
      <ModelParamsFields
        idPrefix="t"
        value={{ ...EMPTY, verbosity: 'high' }}
        onChange={vi.fn()}
        isLocked={(field) => field === 'verbosity'}
      />
    );

    expect(screen.getByRole('combobox', { name: /verbosity/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /service tier/i })).toBeEnabled();
  });

  it('shows a value the caller replaces, as on a form reset', () => {
    const { rerender } = render(
      <ModelParamsFields idPrefix="t" value={EMPTY} onChange={vi.fn()} />
    );
    rerender(
      <ModelParamsFields
        idPrefix="t"
        value={{ ...EMPTY, stopSequences: ['STOP', 'HALT'] }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole('textbox', { name: /stop sequences/i })).toHaveValue('STOP\nHALT');
  });
});
