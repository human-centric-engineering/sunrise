/**
 * UsePatternButton Component Tests
 *
 * @see components/admin/orchestration/learn/use-pattern-button.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UsePatternButton } from '@/components/admin/orchestration/learn/use-pattern-button';

// ─── Mocks ────���───────────────────────────────────────────────────────────────

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// ─── Tests ────────────────────────────────────────────��───────────────────────

describe('UsePatternButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when pattern has no matching step types', () => {
    // Pattern 999 has no entry in the step registry
    const { container } = render(<UsePatternButton patternNumber={999} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a single button for patterns with one step type', () => {
    // Pattern 2 maps to only "route"
    render(<UsePatternButton patternNumber={2} />);

    const button = screen.getByRole('button', { name: /use this pattern/i });
    expect(button).toBeInTheDocument();
    // Should not have a dropdown chevron
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('navigates to workflow builder on click (single step type)', async () => {
    const user = userEvent.setup();
    render(<UsePatternButton patternNumber={2} />);

    await user.click(screen.getByRole('button', { name: /use this pattern/i }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const url = pushMock.mock.calls[0][0] as string;
    expect(url).toContain('/admin/orchestration/workflows/new?definition=');

    // Decode and verify the definition
    const encoded = url.split('definition=')[1];
    const definition = JSON.parse(decodeURIComponent(encoded));
    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0].type).toBe('route');
    expect(definition.entryStepId).toBe('step-1');
    expect(definition.errorStrategy).toBe('fail');
  });

  it('renders a dropdown for patterns with multiple step types', () => {
    // Pattern 1 maps to both "llm_call" and "chain"
    render(<UsePatternButton patternNumber={1} />);

    const button = screen.getByRole('button', { name: /use this pattern/i });
    expect(button).toBeInTheDocument();
  });

  it('shows dropdown items for each step type', async () => {
    const user = userEvent.setup();
    render(<UsePatternButton patternNumber={1} />);

    await user.click(screen.getByRole('button', { name: /use this pattern/i }));

    expect(screen.getByText('LLM Call')).toBeInTheDocument();
    expect(screen.getByText('Chain Step')).toBeInTheDocument();
  });

  it('navigates with correct step type when dropdown item clicked', async () => {
    const user = userEvent.setup();
    render(<UsePatternButton patternNumber={1} />);

    await user.click(screen.getByRole('button', { name: /use this pattern/i }));
    await user.click(screen.getByText('LLM Call'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const url = pushMock.mock.calls[0][0] as string;
    const encoded = url.split('definition=')[1];
    const definition = JSON.parse(decodeURIComponent(encoded));
    expect(definition.steps[0].type).toBe('llm_call');
  });
});
