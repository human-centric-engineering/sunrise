/**
 * LearningTabs Component Tests
 *
 * The component is now URL-driven via `useUrlTabs`: the active tab is
 * derived from `?tab=` and tab clicks call `router.replace(`?tab=…`)`.
 * Tests therefore set the mocked search params before rendering to
 * land on a specific tab, and assert `router.replace` was called for
 * tab-switching behaviour.
 *
 * @see components/admin/orchestration/learn/learning-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import type { PatternSummary } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const replaceMock = vi.fn();
let urlParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => urlParams),
  usePathname: vi.fn(() => '/admin/orchestration/learn'),
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

vi.mock('@/components/admin/orchestration/knowledge/embedding-status-banner', () => ({
  EmbeddingStatusBanner: ({ total, embedded }: { total: number; embedded: number }) => (
    <div data-testid="embedding-status-banner">
      {embedded}/{total} embedded
    </div>
  ),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS: PatternSummary[] = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    description: 'Step-by-step reasoning pattern.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'ReAct',
    description: 'Combines reasoning and acting.',
    chunkCount: 3,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LearningTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    urlParams = new URLSearchParams();
    // Default: embedding status and quiz scores return empty/ok
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('embedding-status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { total: 0, embedded: 0, pending: 0, hasActiveProvider: true },
            }),
            { status: 200 }
          )
        );
      }
      if (urlStr.includes('quiz-scores')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  });

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

  it('clicking Advisor tab calls router.replace with ?tab=advisor', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(replaceMock).toHaveBeenCalledWith(
      '/admin/orchestration/learn?tab=advisor',
      expect.objectContaining({ scroll: false })
    );
  });

  it('clicking Quiz tab calls router.replace with ?tab=quiz', async () => {
    const user = userEvent.setup();
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(replaceMock).toHaveBeenCalledWith(
      '/admin/orchestration/learn?tab=quiz',
      expect.objectContaining({ scroll: false })
    );
  });

  it('opens on the URL-specified tab (?tab=advisor)', () => {
    urlParams = new URLSearchParams('tab=advisor');
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    const advisorTab = screen.getByRole('tab', { name: /advisor/i });
    expect(advisorTab).toHaveAttribute('data-state', 'active');
  });

  it('forwards contextType and contextId to advisor ChatInterface', () => {
    urlParams = new URLSearchParams('tab=advisor');
    render(<LearningTabs patterns={MOCK_PATTERNS} contextType="pattern" contextId="5" />);

    const chatInterfaces = screen.getAllByTestId('chat-interface');
    const advisorChat = chatInterfaces.find(
      (el) => el.getAttribute('data-agent') === 'pattern-advisor'
    );
    expect(advisorChat).toBeDefined();
    expect(advisorChat!.getAttribute('data-context-type')).toBe('pattern');
    expect(advisorChat!.getAttribute('data-context-id')).toBe('5');
  });

  it('shows embedding status banner on the advisor tab when pending chunks exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('embedding-status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { total: 100, embedded: 60, pending: 40, hasActiveProvider: true },
            }),
            { status: 200 }
          )
        );
      }
      if (urlStr.includes('quiz-scores')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    urlParams = new URLSearchParams('tab=advisor');
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await waitFor(() => {
      expect(screen.getByTestId('embedding-status-banner')).toBeInTheDocument();
    });
  });

  it('loads persisted quiz score on mount and renders it on the quiz tab', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('embedding-status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { total: 0, embedded: 0, pending: 0, hasActiveProvider: true },
            }),
            { status: 200 }
          )
        );
      }
      if (urlStr.includes('quiz-scores')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ correct: 7, total: 10 }] }), { status: 200 })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    urlParams = new URLSearchParams('tab=quiz');
    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    await waitFor(() => {
      const badge = screen.getByTestId('quiz-score');
      expect(badge.textContent).toBe('7/10');
    });
  });

  it('handles fetch failures gracefully (no crash)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    render(<LearningTabs patterns={MOCK_PATTERNS} />);

    // Should still render without crashing
    expect(screen.getByRole('tab', { name: /patterns/i })).toBeInTheDocument();
  });
});
