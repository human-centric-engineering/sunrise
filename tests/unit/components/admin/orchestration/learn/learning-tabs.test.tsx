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

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: ({
    agentSlug,
    starterPrompts,
    contextType,
    contextId,
  }: {
    agentSlug: string;
    starterPrompts?: string[];
    contextType?: string;
    contextId?: string;
  }) => (
    <div
      data-testid="chat-interface"
      data-agent={agentSlug}
      data-context-type={contextType ?? ''}
      data-context-id={contextId ?? ''}
    >
      {starterPrompts?.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  ),
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

  it('switches to Advisor tab showing ChatInterface', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });

  it('switches to Quiz tab showing ChatInterface', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });

  it('opens on the specified defaultTab', () => {
    render(<LearningTabs patterns={MOCK_PATTERNS} defaultTab="advisor" />);

    const advisorTab = screen.getByRole('tab', { name: /advisor/i });
    expect(advisorTab).toHaveAttribute('data-state', 'active');
  });

  it('forwards contextType and contextId to advisor ChatInterface', () => {
    render(
      <LearningTabs
        patterns={MOCK_PATTERNS}
        defaultTab="advisor"
        contextType="pattern"
        contextId="5"
      />
    );

    // The advisor ChatInterface should have context props set
    const chatInterfaces = screen.getAllByTestId('chat-interface');
    const advisorChat = chatInterfaces.find(
      (el) => el.getAttribute('data-agent') === 'pattern-advisor'
    );
    expect(advisorChat).toBeDefined();
    expect(advisorChat!.getAttribute('data-context-type')).toBe('pattern');
    expect(advisorChat!.getAttribute('data-context-id')).toBe('5');
  });
});
