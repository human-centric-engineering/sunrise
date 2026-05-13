/**
 * LearningTabs — Quiz Tab Tests
 *
 * Tests the quiz tab's ChatInterface integration and score badge.
 *
 * @see components/admin/orchestration/learn/learning-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import type { PatternSummary } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// `useSearchParams` returns `?tab=quiz` so the Quiz tab renders on
// initial mount — these tests target the quiz content's behaviour
// (score parsing, callback wiring) rather than tab-switching itself.
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams('tab=quiz')),
  usePathname: vi.fn(() => '/admin/orchestration/learn'),
}));

// Capture onStreamComplete so we can invoke it manually
let capturedQuizOnStreamComplete: ((text: string) => void) | undefined;

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: (props: {
    agentSlug: string;
    starterPrompts?: string[];
    onStreamComplete?: (text: string) => void;
  }) => {
    // Only capture the quiz-master's callback (not the advisor's)
    if (props.agentSlug === 'quiz-master') {
      capturedQuizOnStreamComplete = props.onStreamComplete;
    }
    return (
      <div data-testid="chat-interface" data-agent={props.agentSlug}>
        {props.starterPrompts?.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </div>
    );
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS: PatternSummary[] = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    description: 'Step-by-step reasoning.',
    chunkCount: 5,
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LearningTabs — Quiz tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedQuizOnStreamComplete = undefined;
  });

  it('passes quiz-master slug to ChatInterface', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    const chatInterfaces = screen.getAllByTestId('chat-interface');
    const quizChat = chatInterfaces.find((el) => el.getAttribute('data-agent') === 'quiz-master');
    expect(quizChat).toBeDefined();
  });

  it('renders quiz starter prompts', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(screen.getByText("Start a quiz — I'm a beginner")).toBeInTheDocument();
    expect(screen.getByText("Start a quiz — I'm intermediate")).toBeInTheDocument();
    expect(screen.getByText('Test me on Pattern 14 (RAG)')).toBeInTheDocument();
    expect(screen.getByText('Quiz me on workflow composition')).toBeInTheDocument();
  });

  it('shows score badge when quiz-master mentions a score', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(screen.queryByTestId('quiz-score')).not.toBeInTheDocument();

    act(() => {
      capturedQuizOnStreamComplete?.('Correct! The answer is B. Score: 3/5\n\nNext question...');
    });

    const badge = screen.getByTestId('quiz-score');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('3/5');
  });

  it('parses "Score: X out of Y" format', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    act(() => {
      capturedQuizOnStreamComplete?.('Your Score: 2 out of 4 correct so far.');
    });

    const badge = screen.getByTestId('quiz-score');
    expect(badge.textContent).toBe('2/4');
  });

  it('ignores fractions without "score:" prefix (false positive prevention)', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    act(() => {
      capturedQuizOnStreamComplete?.('3/5 of the patterns involve chaining.');
    });

    expect(screen.queryByTestId('quiz-score')).not.toBeInTheDocument();
  });

  it('does not show score badge when text has no score', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    act(() => {
      capturedQuizOnStreamComplete?.('Great question! Let me explain...');
    });

    expect(screen.queryByTestId('quiz-score')).not.toBeInTheDocument();
  });

  it('updates score badge on subsequent completions', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    act(() => {
      capturedQuizOnStreamComplete?.('Score: 1/2');
    });

    expect(screen.getByTestId('quiz-score').textContent).toBe('1/2');

    act(() => {
      capturedQuizOnStreamComplete?.('Score: 2/3');
    });

    expect(screen.getByTestId('quiz-score').textContent).toBe('2/3');
  });
});
