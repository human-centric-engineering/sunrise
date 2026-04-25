/**
 * TestingTabs Component Tests
 *
 * Test Coverage:
 * - Renders both tab triggers (Evaluations, Experiments)
 * - Shows evaluations content by default
 * - Respects defaultTab prop to show experiments first
 * - FieldHelp text accurately describes evaluations as live chat sessions
 * - FieldHelp text describes improvement suggestions from transcript (not annotations)
 *
 * @see components/admin/orchestration/testing-tabs.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TestingTabs } from '@/components/admin/orchestration/testing-tabs';

describe('TestingTabs', () => {
  const evalContent = <div>Evaluations Content</div>;
  const expContent = <div>Experiments Content</div>;

  it('renders both tab triggers', () => {
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    expect(screen.getByRole('tab', { name: /evaluations/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /experiments/i })).toBeInTheDocument();
  });

  it('shows evaluations content by default', () => {
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    expect(screen.getByText('Evaluations Content')).toBeInTheDocument();
  });

  it('shows experiments content when defaultTab is experiments', () => {
    render(
      <TestingTabs
        evaluationsContent={evalContent}
        experimentsContent={expContent}
        defaultTab="experiments"
      />
    );

    expect(screen.getByText('Experiments Content')).toBeInTheDocument();
  });

  it('switches tabs on click', async () => {
    const user = userEvent.setup();
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    await user.click(screen.getByRole('tab', { name: /experiments/i }));

    expect(screen.getByText('Experiments Content')).toBeInTheDocument();
  });

  // ── FieldHelp text accuracy ──────────────────────────────────────────────────

  it('describes evaluations as live chat sessions (not batch prompt testing)', async () => {
    const user = userEvent.setup();
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    // Open the FieldHelp popover
    await user.click(screen.getByRole('button', { name: /more information/i }));

    expect(screen.getByText(/run a live chat session/i)).toBeInTheDocument();
    expect(screen.queryByText(/against a set of prompts/i)).not.toBeInTheDocument();
  });

  it('describes improvement suggestions as coming from the conversation transcript', async () => {
    const user = userEvent.setup();
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    // Open the FieldHelp popover
    await user.click(screen.getByRole('button', { name: /more information/i }));

    expect(
      screen.getByText(/improvement suggestions from the conversation transcript/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/improvement suggestions from annotations/i)).not.toBeInTheDocument();
  });
});
