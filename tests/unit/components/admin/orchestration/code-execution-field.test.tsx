// @vitest-environment happy-dom

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CodeExecutionField } from '@/components/admin/orchestration/code-execution-field';
import type { ProviderTools } from '@/lib/orchestration/llm/types';

/** Holds the value the way a form does, so a change goes round the loop. */
function Harness({
  initial = null,
  onChange,
  disabled,
}: {
  initial?: ProviderTools | null;
  onChange: (next: ProviderTools | null) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CodeExecutionField
      idPrefix="t"
      value={value}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const getSwitch = () => screen.getByRole('switch', { name: /code execution/i });

describe('CodeExecutionField', () => {
  it('shows the switch off when no provider tool is set', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(getSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the switch off when only web search is set', () => {
    render(<Harness initial={{ webSearch: {} }} onChange={vi.fn()} />);
    expect(getSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the switch on when codeExecution is set', () => {
    render(<Harness initial={{ codeExecution: {} }} onChange={vi.fn()} />);
    expect(getSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('turns code execution on from null with an empty options object', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(getSwitch());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ codeExecution: {} });
    expect(getSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps web search, including its options, when turned on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ webSearch: { maxUses: 3 } }} onChange={onChange} />);

    await user.click(getSwitch());

    expect(onChange).toHaveBeenLastCalledWith({
      webSearch: { maxUses: 3 },
      codeExecution: {},
    });
  });

  it('keeps web search when turned off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initial={{ webSearch: { maxUses: 3 }, codeExecution: {} }} onChange={onChange} />
    );

    await user.click(getSwitch());

    expect(onChange).toHaveBeenLastCalledWith({ webSearch: { maxUses: 3 } });
    expect(getSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('sends null when turned off and it was the only tool', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ codeExecution: {} }} onChange={onChange} />);

    await user.click(getSwitch());

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('disables the switch, and sends nothing on click, when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);

    expect(getSwitch()).toBeDisabled();
    await user.click(getSwitch());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves the switch enabled by default', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(getSwitch()).toBeEnabled();
  });

  it('has a help popover titled "Provider code execution"', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);

    expect(screen.queryByText('Provider code execution')).toBeNull();
    await user.click(screen.getByRole('button', { name: /more information/i }));

    expect(await screen.findByText('Provider code execution')).toBeInTheDocument();
  });
});
