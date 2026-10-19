// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Pattern Detail Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/learn/patterns/[number]/page.tsx`.
 *
 * Only a 404 renders "Pattern not found"; any other detail failure throws to
 * the error boundary, and a failed name list shows a notice in place of the
 * related patterns (#518).
 *
 * @see app/admin/orchestration/learn/patterns/[number]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

// Mock react-markdown to avoid ESM issues in test
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_DETAIL = {
  patternName: 'Chain of Thought',
  chunks: [
    {
      id: 'chunk-1',
      chunkKey: 'pattern-1-overview',
      documentId: 'doc-1',
      // Bold line is parsed as the "parallels" caption; italic line as the example.
      content:
        'Pattern 1 — Chain of Thought\n\n**Step-by-step reasoning, like a structured proof.**\n\n*See: a developer thinking aloud while debugging.*',
      chunkType: 'pattern_overview',
      patternNumber: 1,
      patternName: 'Chain of Thought',
      category: 'Reasoning',
      section: 'overview',
      keywords: null,
      estimatedTokens: 50,
      metadata: null,
    },
    {
      id: 'chunk-2',
      chunkKey: 'pattern-1-how-it-works',
      documentId: 'doc-1',
      content: 'How Chain of Thought works in detail',
      chunkType: 'pattern_section',
      patternNumber: 1,
      patternName: 'Chain of Thought',
      category: 'Reasoning',
      section: 'how_it_works',
      keywords: null,
      estimatedTokens: 80,
      metadata: null,
    },
  ],
  totalTokens: 130,
};

const MOCK_NAMES = [{ patternNumber: 1, patternName: 'Chain of Thought' }];

/** Answer the detail load and the pattern-name list separately. */
async function wireFetches({
  detail = () => Promise.resolve(apiSuccess(MOCK_DETAIL)),
  names = () => Promise.resolve(apiSuccess(MOCK_NAMES)),
}: {
  detail?: () => Promise<Response>;
  names?: () => Promise<Response>;
} = {}): Promise<void> {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) =>
    /\/patterns\/\d+/.test(path) ? detail() : names()
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pattern title', async () => {
    await wireFetches();

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByRole('heading', { name: /chain of thought/i })).toBeInTheDocument();
  });

  it('renders breadcrumb with Learning link', async () => {
    await wireFetches();

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByText('Learning')).toBeInTheDocument();
  });

  it('renders content sections', async () => {
    await wireFetches();

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    // Overview chunk is rendered as a labelled subtitle (not a hero card).
    expect(screen.getByText(/software-engineering parallels/i)).toBeInTheDocument();
    expect(
      screen.getByText(/step-by-step reasoning, like a structured proof/i)
    ).toBeInTheDocument();
    // Non-hero sections render as collapsed accordion items — trigger text is visible
    expect(screen.getByText(/how it works/i)).toBeInTheDocument();
  });

  it('renders not-found when pattern does not exist', async () => {
    await wireFetches({ detail: () => Promise.resolve(apiFailure(404, 'NOT_FOUND')) });

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '999' }) }));

    expect(screen.getByText(/pattern not found/i)).toBeInTheDocument();
  });

  it('throws to the error boundary, not "Pattern not found", when the detail load fails', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await wireFetches({ detail: () => Promise.resolve(apiFailure(500)) });

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    await expect(
      PatternDetailPage({ params: Promise.resolve({ number: '1' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('shows a notice in place of related patterns when the name list fails', async () => {
    await wireFetches({ names: () => Promise.resolve(apiFailure(500)) });

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByRole('heading', { name: /chain of thought/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load related patterns/i);
  });

  it('renders invalid message for non-numeric param', async () => {
    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: 'abc' }) }));

    expect(screen.getByText(/invalid pattern number/i)).toBeInTheDocument();
  });
});
