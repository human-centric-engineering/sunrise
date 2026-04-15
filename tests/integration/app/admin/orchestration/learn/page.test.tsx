/**
 * Integration Test: Admin Orchestration — Learning Hub Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/learn/page.tsx`.
 *
 * @see app/admin/orchestration/learn/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  listPatterns: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: () => <div data-testid="chat-interface" />,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'Reasoning',
    complexity: 'beginner',
    description: 'A pattern for step-by-step reasoning.',
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

describe('LearnPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Learning" heading', async () => {
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockResolvedValue(MOCK_PATTERNS as any);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage());

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
  });

  it('renders pattern cards with names', async () => {
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockResolvedValue(MOCK_PATTERNS as any);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage());

    expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('renders empty state when listPatterns returns empty array', async () => {
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockResolvedValue([]);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage());

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
    expect(screen.getByText(/no patterns found/i)).toBeInTheDocument();
  });

  it('does not throw when listPatterns rejects', async () => {
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockRejectedValue(new Error('Search error'));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    let thrown = false;
    try {
      render(await LearnPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
  });

  it('advisor tab renders ChatInterface component', async () => {
    const user = userEvent.setup();
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockResolvedValue(MOCK_PATTERNS as any);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage());

    await user.click(screen.getByRole('tab', { name: /advisor/i }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });

  it('quiz tab renders ChatInterface component', async () => {
    const user = userEvent.setup();
    const { listPatterns } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(listPatterns).mockResolvedValue(MOCK_PATTERNS as any);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage());

    await user.click(screen.getByRole('tab', { name: /quiz/i }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
