/**
 * FieldHelp Component Tests
 *
 * Covers the trigger button, popover open/close via click, keyboard
 * accessibility, and child rendering.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FieldHelp } from '@/components/ui/field-help';

describe('FieldHelp', () => {
  it('renders an accessible trigger button', () => {
    render(<FieldHelp>Help text here</FieldHelp>);
    const trigger = screen.getByRole('button', { name: /more information/i });
    expect(trigger).toBeInTheDocument();
  });

  it('accepts a custom ariaLabel', () => {
    render(<FieldHelp ariaLabel="Model help">Body</FieldHelp>);
    expect(screen.getByRole('button', { name: 'Model help' })).toBeInTheDocument();
  });

  it('opens the popover on click and shows children', async () => {
    const user = userEvent.setup();
    render(
      <FieldHelp title="LLM model">
        <p>The exact model identifier.</p>
      </FieldHelp>
    );

    await user.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('LLM model')).toBeInTheDocument();
    });
    expect(screen.getByText('The exact model identifier.')).toBeInTheDocument();
  });

  it('closes the popover on Escape', async () => {
    const user = userEvent.setup();
    render(
      <FieldHelp title="Title">
        <p>Body content</p>
      </FieldHelp>
    );

    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('Title')).toBeInTheDocument());

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText('Title')).not.toBeInTheDocument();
    });
  });

  it('renders children without a title heading when title is omitted', async () => {
    const user = userEvent.setup();
    render(<FieldHelp>Just a body</FieldHelp>);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('Just a body')).toBeInTheDocument());
  });
});
