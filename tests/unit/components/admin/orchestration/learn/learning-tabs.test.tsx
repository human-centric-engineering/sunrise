/**
 * LearningTabs Component Tests
 *
 * @see components/admin/orchestration/learn/learning-tabs.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import type { PatternSummary } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS: PatternSummary[] = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'Reasoning',
    complexity: 'beginner',
    description: 'Step-by-step reasoning pattern.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'ReAct',
    category: 'Action',
    complexity: 'intermediate',
    description: 'Combines reasoning and acting.',
    chunkCount: 3,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LearningTabs', () => {
  it('renders all three tab triggers', () => {
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    expect(screen.getByRole('tab', { name: /patterns/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /advisor/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /quiz/i })).toBeInTheDocument();
  });

  it('defaults to Patterns tab showing pattern cards', () => {
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('switches to Advisor tab showing placeholder', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(screen.getByText(/pattern advisor/i)).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('switches to Quiz tab showing placeholder', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(screen.getByText(/knowledge quiz/i)).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
