// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Learning Hub Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/learn/page.tsx`.
 *
 * A failed pattern load throws to the error boundary rather than reading as
 * an empty catalogue (#518); a real empty catalogue still shows the empty state.
 *
 * @see app/admin/orchestration/learn/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mutable URL params so individual tests can simulate landing on a
// specific tab. `LearningTabs` reads tabs from `useSearchParams` via
// `useUrlTabs`, so we can't drive a tab change with a click in the
// test environment (the mock doesn't re-render on `router.replace`).
let urlParams = new URLSearchParams();

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
  unstable_rethrow: vi.fn(),
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

/** Answer the pattern load with `patterns`; the agent lookups find nothing. */
async function mockPatterns(patterns: () => Promise<Response>): Promise<void> {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) =>
    path.includes('/agents') ? Promise.resolve(apiSuccess([])) : patterns()
  );
}

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
    await mockPatterns(() => Promise.resolve(apiSuccess(MOCK_PATTERNS)));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
  });

  it('renders pattern cards with names', async () => {
    await mockPatterns(() => Promise.resolve(apiSuccess(MOCK_PATTERNS)));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('renders the empty state when there are no patterns', async () => {
    await mockPatterns(() => Promise.resolve(apiSuccess([])));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: /^learning$/i })).toBeInTheDocument();
    expect(screen.getByText(/no patterns found/i)).toBeInTheDocument();
  });

  it('throws to the error boundary when the pattern load fails', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockPatterns(() => Promise.resolve(apiFailure(500)));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    // Not "No patterns found"
    await expect(LearnPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      ServerLoadError
    );
  });

  it('throws to the error boundary when the pattern fetch rejects', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockPatterns(() => Promise.reject(new Error('Network error')));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    await expect(LearnPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      ServerLoadError
    );
  });

  it('renders ChatInterface on the advisor tab when URL has ?tab=advisor', async () => {
    urlParams = new URLSearchParams('tab=advisor');
    await mockPatterns(() => Promise.resolve(apiSuccess(MOCK_PATTERNS)));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });

  it('renders ChatInterface on the quiz tab when URL has ?tab=quiz', async () => {
    urlParams = new URLSearchParams('tab=quiz');
    await mockPatterns(() => Promise.resolve(apiSuccess(MOCK_PATTERNS)));

    const { default: LearnPage } = await import('@/app/admin/orchestration/learn/page');

    render(await LearnPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
