// @vitest-environment happy-dom

/**
 * Unit Tests: PatternDetailPage
 * (app/admin/orchestration/learn/patterns/[number]/page.tsx)
 *
 * Branch coverage targets:
 * - params.number is not a number (isNaN) → renders "Invalid pattern number" fallback
 * - params.number below 1 → "Invalid pattern number" without a fetch (the API
 *   would reject it with a 400)
 * - getPatternDetail: API 404 → renders "Pattern not found" fallback
 * - getPatternDetail: any other failure (error status, error envelope, network
 *   error) → ServerLoadError to the error boundary (#518)
 * - detail.chunks.length === 0 → renders "Pattern not found" fallback
 * - getPatternNames failure → notice in place of RelatedPatterns, page renders
 * - Happy path: renders pattern name, hero/rest chunks, related patterns
 * - overview chunk: rendered as labelled subtitle in header, not a hero card
 * - heroChunks: sections "tldr" / "summary" → hero cards
 * - restChunks: other sections → accordion (PatternDetailSections rendered)
 * - restChunks empty → PatternDetailSections NOT rendered
 * - generateMetadata: isNaN → "Pattern Not Found" title
 * - generateMetadata: detail found → pattern name in title
 * - generateMetadata: detail load failed → fallback title (the page throws)
 * - generateMetadata: detail.patternName null → fallback title
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/learn/patterns/[number]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/utils/extract-related-patterns', () => ({
  extractRelatedPatterns: vi.fn(() => []),
}));

vi.mock('@/lib/orchestration/utils/strip-embedding-prefix', () => ({
  stripEmbeddingPrefix: vi.fn((s: string) => s),
}));

// Stub child components so we can inspect what the page passes them
vi.mock('@/components/admin/orchestration/learn/pattern-content', () => ({
  PatternContent: ({ content }: { content: string }) => (
    <div data-testid="pattern-content" data-content={content} />
  ),
}));

vi.mock('@/components/admin/orchestration/learn/pattern-detail-sections', () => ({
  PatternDetailSections: ({ chunks }: { chunks: unknown[] }) => (
    <div data-testid="pattern-detail-sections" data-chunks-count={String(chunks.length)} />
  ),
}));

vi.mock('@/components/admin/orchestration/learn/related-patterns', () => ({
  RelatedPatterns: ({ patterns }: { patterns: unknown[] }) => (
    <div data-testid="related-patterns" data-patterns-count={String(patterns.length)} />
  ),
}));

vi.mock('@/components/admin/orchestration/learn/discuss-pattern-button', () => ({
  DiscussPatternButton: ({ patternNumber }: { patternNumber: number }) => (
    <button data-testid="discuss-button" data-pattern-number={String(patternNumber)}>
      Discuss
    </button>
  ),
}));

vi.mock('@/components/admin/orchestration/learn/use-pattern-button', () => ({
  UsePatternButton: ({ patternNumber }: { patternNumber: number }) => (
    <button data-testid="use-button" data-pattern-number={String(patternNumber)}>
      Use
    </button>
  ),
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import PatternDetailPage, {
  generateMetadata,
} from '@/app/admin/orchestration/learn/patterns/[number]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { extractRelatedPatterns } from '@/lib/orchestration/utils/extract-related-patterns';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Answer = () => Promise<Response>;

const ok =
  (data: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data));

/** A 200 whose body is an error envelope. */
const errorEnvelope: Answer = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );

/**
 * Route the page's two loads by URL — the pattern detail
 * (`/knowledge/patterns/:n`) and the name list (`/knowledge/patterns`) — to
 * fresh `Response`s. The name list defaults to empty.
 */
function wireFetches({ detail, names = ok([]) }: { detail: Answer; names?: Answer }): void {
  vi.mocked(serverFetch).mockImplementation((url: string) =>
    /\/patterns\/\d+/.test(url) ? detail() : names()
  );
}

function makeChunk(id: string, section: string | null, content = 'chunk content') {
  return {
    id,
    section,
    content,
    patternNumber: 1,
    orderIndex: 0,
    tokens: 100,
    chunkIndex: 0,
    chunkCount: 1,
    metadata: null,
    embeddingId: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

const PATTERN_NAME = 'Chain of Thought';

function makePatternDetail(chunks = [makeChunk('c1', 'overview'), makeChunk('c2', 'when_to_use')]) {
  return {
    patternName: PATTERN_NAME,
    chunks,
    totalTokens: 200,
  };
}

// Default: server returns ok but pattern detail fetch returns data
// and patternNames returns an empty Map (no related patterns)
function setupHappyPath(detail: unknown = makePatternDetail()) {
  wireFetches({ detail: ok(detail) });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: extractRelatedPatterns returns []
    vi.mocked(extractRelatedPatterns).mockReturnValue([]);
  });

  // ── Invalid param (isNaN) ─────────────────────────────────────────────────

  it('renders "Invalid pattern number" message when params.number is not a number', async () => {
    // Arrange
    const params = Promise.resolve({ number: 'not-a-number' });

    // Act
    render(await PatternDetailPage({ params }));

    // Assert: fallback for NaN path
    expect(screen.getByText('Invalid pattern number.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Learning' })).toHaveAttribute(
      'href',
      '/admin/orchestration/learn'
    );
  });

  it('does not call serverFetch when params.number is invalid', async () => {
    // Arrange
    const params = Promise.resolve({ number: 'abc' });

    // Act
    render(await PatternDetailPage({ params }));

    // Assert: no fetch was attempted
    expect(serverFetch).not.toHaveBeenCalled();
  });

  // The API rejects each of these with a 400, which would otherwise reach the
  // error boundary with a "Try again" that can never succeed.
  it.each([
    ['below 1', '0'],
    ['not an integer', '2.5'],
    ['past the safe-integer range', '99999999999999999999'],
  ])('treats a number %s as invalid without fetching', async (_label, number) => {
    render(await PatternDetailPage({ params: Promise.resolve({ number }) }));

    expect(screen.getByText('Invalid pattern number.')).toBeInTheDocument();
    expect(serverFetch).not.toHaveBeenCalled();
  });

  // ── getPatternDetail error branches ─────────────────────────────────────

  describe('getPatternDetail', () => {
    it('renders "Pattern not found" when the API answers 404', async () => {
      // Arrange
      wireFetches({ detail: () => Promise.resolve(apiFailure(404, 'NOT_FOUND')) });
      const params = Promise.resolve({ number: '3' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to Learning' })).toHaveAttribute(
        'href',
        '/admin/orchestration/learn'
      ); // A pattern with no chunks is a normal answer here, not a failure to log.
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('throws ServerLoadError, not "Pattern not found", when the load fails', async () => {
      // Arrange
      wireFetches({ detail: () => Promise.resolve(apiFailure(500)) });
      const params = Promise.resolve({ number: '3' });

      // Act + Assert
      await expect(PatternDetailPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    });

    it('throws ServerLoadError when the API answers with an error envelope', async () => {
      // Arrange
      wireFetches({ detail: errorEnvelope });
      const params = Promise.resolve({ number: '5' });

      // Act + Assert
      await expect(PatternDetailPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    });

    it('logs and throws ServerLoadError when serverFetch throws', async () => {
      // Arrange
      const fetchErr = new Error('Network failure');
      wireFetches({ detail: () => Promise.reject(fetchErr) });
      const params = Promise.resolve({ number: '7' });

      // Act + Assert
      await expect(PatternDetailPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed: no response',
        fetchErr,
        expect.objectContaining({ path: API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(7) })
      );
    });

    it('renders "Pattern not found" when detail has no chunks', async () => {
      // Arrange — detail returned but chunks array is empty
      setupHappyPath({ patternName: PATTERN_NAME, chunks: [], totalTokens: 0 });
      const params = Promise.resolve({ number: '2' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: detail.chunks.length === 0 path → not found state
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
    });
  });

  // ── getPatternNames failure ─────────────────────────────────────────────

  describe('getPatternNames', () => {
    it('shows a notice in place of related patterns when the name list fails', async () => {
      // Arrange — detail succeeds, the name list fails
      wireFetches({
        detail: ok(makePatternDetail()),
        names: () => Promise.resolve(apiFailure(500)),
      });
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: the pattern still renders; "no related patterns" is not implied
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load related patterns/i);
      expect(screen.queryByTestId('related-patterns')).not.toBeInTheDocument();
    });

    it('shows the notice when the name list fetch throws', async () => {
      // Arrange
      wireFetches({
        detail: ok(makePatternDetail()),
        names: () => Promise.reject(new Error('names failed')),
      });
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByTestId('related-patterns')).not.toBeInTheDocument();
    });

    it('renders related patterns and no notice when the name list loads', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(screen.getByTestId('related-patterns')).toHaveAttribute('data-patterns-count', '0');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  // ── Happy path rendering ──────────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders the pattern name as the page heading', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: pattern name appears in the heading
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
    });

    it('renders the Discuss and Use buttons with the pattern number', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: action buttons rendered with correct pattern number
      expect(screen.getByTestId('discuss-button')).toHaveAttribute('data-pattern-number', '1');
      expect(screen.getByTestId('use-button')).toHaveAttribute('data-pattern-number', '1');
    });

    it('calls the correct endpoint for getPatternDetail', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '42' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: the knowledgePatternByNumber endpoint was called with num=42
      expect(serverFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(42),
        undefined
      );
    });

    it('renders breadcrumb links to /admin/orchestration and /admin/orchestration/learn', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: breadcrumb nav links
      expect(screen.getByRole('link', { name: 'AI Orchestration' })).toHaveAttribute(
        'href',
        '/admin/orchestration'
      );
      expect(screen.getByRole('link', { name: 'Learning' })).toHaveAttribute(
        'href',
        '/admin/orchestration/learn'
      );
    });
  });

  // ── heroChunks / restChunks split ────────────────────────────────────────

  describe('hero vs rest chunks', () => {
    it('renders "overview" section as a labelled subtitle, not a hero card', async () => {
      // Arrange — overview content with parseable bold line for parallels
      const overviewContent = '**Step-by-step reasoning, like a structured proof.**';
      const detail = makePatternDetail([
        makeChunk('c1', 'overview', overviewContent),
        makeChunk('c2', 'when_to_use', 'When to use'),
      ]);
      setupHappyPath(detail);
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: overview renders as a labelled subtitle, NOT as a PatternContent card
      expect(screen.getByText(/software-engineering parallels/i)).toBeInTheDocument();
      expect(
        screen.getByText(/step-by-step reasoning, like a structured proof/i)
      ).toBeInTheDocument();
      expect(screen.queryByTestId('pattern-content')).not.toBeInTheDocument();
    });

    it('routes "tldr" section chunks to hero cards', async () => {
      // Arrange — "tldr" is a HERO_SECTION
      const detail = makePatternDetail([makeChunk('c1', 'tldr', 'TL;DR content')]);
      setupHappyPath(detail);
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: PatternDetailSections NOT rendered (restChunks is empty)
      expect(screen.queryByTestId('pattern-detail-sections')).not.toBeInTheDocument();
    });

    it('renders PatternDetailSections when there are non-hero chunks', async () => {
      // Arrange
      const detail = makePatternDetail([
        makeChunk('c1', 'overview', 'overview content'),
        makeChunk('c2', 'deep_dive', 'Deep dive section'),
      ]);
      setupHappyPath(detail);
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: non-hero chunks go to PatternDetailSections
      const sections = screen.getByTestId('pattern-detail-sections');
      expect(sections).toHaveAttribute('data-chunks-count', '1');
    });

    it('does NOT render PatternDetailSections when all chunks are hero sections', async () => {
      // Arrange — only overview chunk
      const detail = makePatternDetail([makeChunk('c1', 'overview', 'overview content')]);
      setupHappyPath(detail);
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: no rest chunks → PatternDetailSections not rendered
      expect(screen.queryByTestId('pattern-detail-sections')).not.toBeInTheDocument();
    });
  });

  // ── generateMetadata ──────────────────────────────────────────────────────

  describe('generateMetadata', () => {
    it('returns "Pattern Not Found" title when params.number is not a number', async () => {
      // Arrange
      const params = Promise.resolve({ number: 'xyz' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: isNaN path → fallback title
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });

    it('returns pattern name in title when detail is found', async () => {
      // Arrange
      setupHappyPath();
      const params = Promise.resolve({ number: '1' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: detail.patternName used in title
      expect(metadata.title).toBe(`${PATTERN_NAME} · Learning · AI Orchestration`);
    });

    it('returns "Pattern Not Found" title when the pattern does not exist', async () => {
      // Arrange
      wireFetches({ detail: () => Promise.resolve(apiFailure(404, 'NOT_FOUND')) });
      const params = Promise.resolve({ number: '99' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: no detail → fallback title
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });

    it('returns the fallback title, without throwing, when the detail load fails', async () => {
      // Arrange — the page itself throws for this; metadata must not.
      wireFetches({ detail: () => Promise.resolve(apiFailure(500)) });
      const params = Promise.resolve({ number: '99' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });

    it('returns "Pattern Not Found" title when detail.patternName is null', async () => {
      // Arrange — detail returned but patternName is null
      setupHappyPath({ patternName: null, chunks: [], totalTokens: 0 });
      const params = Promise.resolve({ number: '3' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: null patternName → fallback title
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });
  });
});
