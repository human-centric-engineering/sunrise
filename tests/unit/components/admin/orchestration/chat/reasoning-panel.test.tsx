// @vitest-environment happy-dom

/**
 * Unit Test: ReasoningPanel
 *
 * @see components/admin/orchestration/chat/reasoning-panel.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReasoningPanel } from '@/components/admin/orchestration/chat/reasoning-panel';

describe('ReasoningPanel', () => {
  it('renders nothing when the text is empty', () => {
    const { container } = render(<ReasoningPanel text="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the text is only whitespace', () => {
    const { container } = render(<ReasoningPanel text={'\n\n '} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('starts collapsed with a word count, and toggles the text', async () => {
    const user = userEvent.setup();
    render(<ReasoningPanel text="  Check the order status first.  " />);

    const toggle = screen.getByRole('button', { name: 'Reasoning · 5 words' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('reasoning-panel-text')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('reasoning-panel-text')).toHaveTextContent(
      'Check the order status first.'
    );

    await user.click(toggle);
    expect(screen.queryByTestId('reasoning-panel-text')).not.toBeInTheDocument();
  });

  it('uses the singular for one word', () => {
    render(<ReasoningPanel text="Done." />);

    expect(screen.getByRole('button', { name: 'Reasoning · 1 word' })).toBeInTheDocument();
  });

  it('says it is still reasoning while streaming', () => {
    render(<ReasoningPanel text="Looking it up" streaming />);

    expect(screen.getByRole('button', { name: 'Reasoning…' })).toBeInTheDocument();
  });

  it('opens straight away when defaultOpen is set', () => {
    render(<ReasoningPanel text="Looking it up" defaultOpen />);

    expect(screen.getByTestId('reasoning-panel-text')).toHaveTextContent('Looking it up');
  });
});
