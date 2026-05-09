/**
 * TestingTabs Component Tests
 *
 * Test Coverage:
 * - Renders both tab triggers (Evaluations, Experiments)
 * - Shows evaluations content by default
 * - Shows experiments content when URL has ?tab=experiments
 * - Clicking a tab calls router.replace with the right URL
 * - FieldHelp text accurately describes evaluations as live chat sessions
 * - FieldHelp text describes improvement suggestions from transcript (not annotations)
 *
 * @see components/admin/orchestration/testing-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { TestingTabs } from '@/components/admin/orchestration/testing-tabs';

describe('TestingTabs', () => {
  const evalContent = <div>Evaluations Content</div>;
  const expContent = <div>Experiments Content</div>;
  const replaceMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: replaceMock,
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>
    );
  });

  it('renders both tab triggers', () => {
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    expect(screen.getByRole('tab', { name: /evaluations/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /experiments/i })).toBeInTheDocument();
  });

  it('shows evaluations content by default', () => {
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    expect(screen.getByText('Evaluations Content')).toBeInTheDocument();
  });

  it('shows experiments content when URL has ?tab=experiments', () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('tab=experiments') as ReturnType<typeof useSearchParams>
    );
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    expect(screen.getByText('Experiments Content')).toBeInTheDocument();
  });

  it('clicking the experiments tab calls router.replace with ?tab=experiments', async () => {
    const user = userEvent.setup();
    render(<TestingTabs evaluationsContent={evalContent} experimentsContent={expContent} />);

    await user.click(screen.getByRole('tab', { name: /experiments/i }));

    expect(replaceMock).toHaveBeenCalledWith(
      expect.stringContaining('tab=experiments'),
      expect.objectContaining({ scroll: false })
    );
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
