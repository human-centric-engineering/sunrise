// @vitest-environment happy-dom

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WebSearchFields } from '@/components/admin/orchestration/web-search-fields';
import type { ProviderTools } from '@/lib/orchestration/llm/types';

/** Holds the value the way a form does, so typing goes round the loop. */
function Harness({
  initial = null,
  onChange,
}: {
  initial?: ProviderTools | null;
  onChange: (next: ProviderTools | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <WebSearchFields
      idPrefix="t"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('WebSearchFields', () => {
  it('turns web search on with no options, and off again to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    expect(screen.queryByRole('spinbutton')).toBeNull();
    await user.click(screen.getByRole('switch', { name: /web search/i }));
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: {} });

    await user.click(screen.getByRole('switch', { name: /web search/i }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps code execution when web search is turned off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initial={{ webSearch: { maxUses: 2 }, codeExecution: {} }} onChange={onChange} />
    );

    await user.click(screen.getByRole('switch', { name: /web search/i }));

    expect(onChange).toHaveBeenLastCalledWith({ codeExecution: {} });
  });

  it('sends null when web search is turned off and nothing else is left', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ webSearch: { maxUses: 2 } }} onChange={onChange} />);

    await user.click(screen.getByRole('switch', { name: /web search/i }));

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps code execution when web search is turned on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ codeExecution: {} }} onChange={onChange} />);

    await user.click(screen.getByRole('switch', { name: /web search/i }));

    expect(onChange).toHaveBeenLastCalledWith({ codeExecution: {}, webSearch: {} });
  });

  it('keeps code execution when the search limit is edited and cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ webSearch: {}, codeExecution: {} }} onChange={onChange} />);

    const input = screen.getByRole('spinbutton', { name: /most searches/i });
    await user.type(input, '4');
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: { maxUses: 4 }, codeExecution: {} });
    await user.clear(input);
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: {}, codeExecution: {} });
  });

  it('sends the search limit, and drops it when the box is cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ webSearch: {} }} onChange={onChange} />);

    const input = screen.getByRole('spinbutton', { name: /most searches/i });
    await user.type(input, '3');
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: { maxUses: 3 } });
    await user.clear(input);
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: {} });
  });

  it('sends the sites typed, one per line, as the list the mode names', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ webSearch: {} }} onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: /sites/i }));
    await user.click(await screen.findByRole('option', { name: 'Only these sites' }));
    expect(onChange).toHaveBeenLastCalledWith({ webSearch: { allowedDomains: [] } });

    const box = screen.getByRole('textbox', { name: /sites to search/i });
    await user.type(box, 'example.com{Enter}docs.example.org');
    expect(box).toHaveValue('example.com\ndocs.example.org');
    expect(onChange).toHaveBeenLastCalledWith({
      webSearch: { allowedDomains: ['example.com', 'docs.example.org'] },
    });

    // Switching the mode moves the same sites to the other list.
    await user.click(screen.getByRole('combobox', { name: /sites/i }));
    await user.click(await screen.findByRole('option', { name: 'Any site except these' }));
    expect(onChange).toHaveBeenLastCalledWith({
      webSearch: { blockedDomains: ['example.com', 'docs.example.org'] },
    });
  });

  it('shows a stored block list in its mode and box', () => {
    render(
      <Harness initial={{ webSearch: { blockedDomains: ['spam.example'] } }} onChange={vi.fn()} />
    );
    expect(screen.getByRole('textbox', { name: /never to search/i })).toHaveValue('spam.example');
  });

  it('shows the validation message it is given', () => {
    render(
      <WebSearchFields
        idPrefix="t"
        value={{ webSearch: {} }}
        onChange={vi.fn()}
        error="At most 20 searches"
      />
    );
    expect(screen.getByText('At most 20 searches')).toBeTruthy();
  });
});
