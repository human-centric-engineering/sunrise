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

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mutable URL params so individual tests can simulate landing on a
// specific tab. `LearningTabs` reads tabs from `useSearchParams` via
// `useUrlTabs`, so we can't drive a tab change with a click in the
// test environment (the mock doesn't re-render on `router.replace`).
let urlParams = new URLSearchParams();

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
  useSearchParams: vi.fn(() => urlParams),
  usePathname: vi.fn(() => '/admin/orchestration/learn'),
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
    urlParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Learning" heading', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_PATTERNS,
    });

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
  });

  it('renders pattern cards with names', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_PATTERNS,
    });

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('renders empty state when fetch returns not ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
    expect(screen.getByText(/no patterns found/i)).toBeInTheDocument();
  });

  it('does not throw when fetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    let thrown = false;
    try {
      render(await LearnPage({ searchParams: Promise.resolve({}) }));
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
  });

  it('renders ChatInterface on the advisor tab when URL has ?tab=advisor', async () => {
    urlParams = new URLSearchParams('tab=advisor');
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_PATTERNS,
    });

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });

  it('renders ChatInterface on the quiz tab when URL has ?tab=quiz', async () => {
    urlParams = new URLSearchParams('tab=quiz');
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_PATTERNS,
    });

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
