/**
 * Integration Test: Admin Orchestration — Pattern Detail Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/learn/patterns/[number]/page.tsx`.
 *
 * @see app/admin/orchestration/learn/patterns/[number]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  getPatternDetail: vi.fn(),
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
      content: 'Overview content about Chain of Thought',
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pattern title', async () => {
    const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(getPatternDetail).mockResolvedValue(MOCK_DETAIL as any);

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByRole('heading', { name: /chain of thought/i })).toBeInTheDocument();
  });

  it('renders breadcrumb with Learning link', async () => {
    const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(getPatternDetail).mockResolvedValue(MOCK_DETAIL as any);

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByText('Learning')).toBeInTheDocument();
  });

  it('renders content sections', async () => {
    const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(getPatternDetail).mockResolvedValue(MOCK_DETAIL as any);

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '1' }) }));

    expect(screen.getByText(/overview content/i)).toBeInTheDocument();
    expect(screen.getByText(/how chain of thought works/i)).toBeInTheDocument();
  });

  it('renders not-found when pattern does not exist', async () => {
    const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
    vi.mocked(getPatternDetail).mockResolvedValue({ patternName: '', chunks: [], totalTokens: 0 });

    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: '999' }) }));

    expect(screen.getByText(/pattern not found/i)).toBeInTheDocument();
  });

  it('renders invalid message for non-numeric param', async () => {
    const { default: PatternDetailPage } =
      await import('@/app/admin/orchestration/learn/patterns/[number]/page');

    render(await PatternDetailPage({ params: Promise.resolve({ number: 'abc' }) }));

    expect(screen.getByText(/invalid pattern number/i)).toBeInTheDocument();
  });
});
