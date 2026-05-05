/**
 * Unit Tests: PatternDetailPage
 * (app/admin/orchestration/learn/patterns/[number]/page.tsx)
 *
 * Branch coverage targets:
 * - params.number is not a number (isNaN) → renders "Invalid pattern number" fallback
 * - getPatternDetail: res.ok false → null
 * - getPatternDetail: body.success false → null
 * - getPatternDetail: serverFetch throws → null + logger.error
 * - detail === null → renders "Pattern not found" fallback
 * - detail.chunks.length === 0 → renders "Pattern not found" fallback
 * - getPatternNames: res.ok false → empty Map
 * - getPatternNames: body.success false → empty Map
 * - getPatternNames: serverFetch throws → empty Map (no logger call per source)
 * - Happy path: renders pattern name, hero/rest chunks, related patterns
 * - overview chunk: rendered as labelled subtitle in header, not a hero card
 * - heroChunks: sections "tldr" / "summary" → hero cards
 * - restChunks: other sections → accordion (PatternDetailSections rendered)
 * - restChunks empty → PatternDetailSections NOT rendered
 * - generateMetadata: isNaN → "Pattern Not Found" title
 * - generateMetadata: detail found → pattern name in title
 * - generateMetadata: detail.patternName null → fallback title
 * - No auth-redirect test: per gotcha #21, auth guard lives in the admin layout.
 *
 * @see app/admin/orchestration/learn/patterns/[number]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import PatternDetailPage, {
  generateMetadata,
} from '@/app/admin/orchestration/learn/patterns/[number]/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { extractRelatedPatterns } from '@/lib/orchestration/utils/extract-related-patterns';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
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
function setupHappyPath(detail = makePatternDetail()) {
  vi.mocked(serverFetch).mockResolvedValue(okResponse());
  vi.mocked(parseApiResponse)
    .mockResolvedValueOnce({ success: true, data: detail } as never) // getPatternDetail
    .mockResolvedValueOnce({ success: true, data: [] } as never); // getPatternNames
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

  // ── getPatternDetail error branches ─────────────────────────────────────

  describe('getPatternDetail', () => {
    it('renders "Pattern not found" when res.ok is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const params = Promise.resolve({ number: '3' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to Learning' })).toHaveAttribute(
        'href',
        '/admin/orchestration/learn'
      );
    });

    it('renders "Pattern not found" when body.success is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'not found' },
      } as never);
      const params = Promise.resolve({ number: '5' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
    });

    it('logs error and renders "Pattern not found" when serverFetch throws', async () => {
      // Arrange
      const fetchErr = new Error('Network failure');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const params = Promise.resolve({ number: '7' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert
      expect(logger.error).toHaveBeenCalledWith('pattern detail page: fetch failed', fetchErr);
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
    });

    it('renders "Pattern not found" when detail has no chunks', async () => {
      // Arrange — detail returned but chunks array is empty
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({
          success: true,
          data: { patternName: PATTERN_NAME, chunks: [], totalTokens: 0 },
        } as never) // getPatternDetail
        .mockResolvedValueOnce({ success: true, data: [] } as never); // getPatternNames
      const params = Promise.resolve({ number: '2' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: detail.chunks.length === 0 path → not found state
      expect(screen.getByText('Pattern not found.')).toBeInTheDocument();
    });
  });

  // ── getPatternNames error branches ───────────────────────────────────────

  describe('getPatternNames', () => {
    it('renders happy path when getPatternNames fails (res.ok false) — falls back to empty Map', async () => {
      // Arrange — detail succeeds, patternNames fails
      const detail = makePatternDetail();
      vi.mocked(serverFetch)
        .mockResolvedValueOnce(okResponse()) // detail
        .mockResolvedValueOnce(notOkResponse()); // patternNames
      vi.mocked(parseApiResponse).mockResolvedValueOnce({
        success: true,
        data: detail,
      } as never);
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: page still renders (empty patternNames → no related patterns shown)
      // Use getByRole to avoid ambiguity between <h1> and <span> breadcrumb
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
      const relatedPatterns = screen.getByTestId('related-patterns');
      expect(relatedPatterns).toHaveAttribute('data-patterns-count', '0');
    });

    it('renders happy path when getPatternNames body.success is false', async () => {
      // Arrange
      const detail = makePatternDetail();
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: detail } as never) // detail
        .mockResolvedValueOnce({ success: false } as never); // patternNames
      const params = Promise.resolve({ number: '1' });

      // Act
      render(await PatternDetailPage({ params }));

      // Assert: page still renders
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
    });

    it('renders happy path when getPatternNames throws — catch returns empty Map', async () => {
      // Arrange — pattern detail succeeds, getPatternNames throws
      const detail = makePatternDetail();
      vi.mocked(serverFetch)
        .mockResolvedValueOnce(okResponse()) // detail
        .mockRejectedValueOnce(new Error('names failed')); // patternNames
      vi.mocked(parseApiResponse).mockResolvedValueOnce({
        success: true,
        data: detail,
      } as never);
      const params = Promise.resolve({ number: '1' });

      // Act — should not crash; getPatternNames catch returns new Map()
      render(await PatternDetailPage({ params }));

      // Assert: page still renders
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PATTERN_NAME);
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
        API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(42)
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
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: detail } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never);
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
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: detail } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never);
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
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: detail } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never);
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
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: detail } as never)
        .mockResolvedValueOnce({ success: true, data: [] } as never);
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
      const detail = makePatternDetail();
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: detail } as never);
      const params = Promise.resolve({ number: '1' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: detail.patternName used in title
      expect(metadata.title).toBe(`${PATTERN_NAME} · Learning · AI Orchestration`);
    });

    it('returns "Pattern Not Found" title when detail is null (res.ok false)', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const params = Promise.resolve({ number: '99' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: null detail → fallback title
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });

    it('returns "Pattern Not Found" title when detail.patternName is null', async () => {
      // Arrange — detail returned but patternName is null
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { patternName: null, chunks: [], totalTokens: 0 },
      } as never);
      const params = Promise.resolve({ number: '3' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: null patternName → fallback title
      expect(metadata.title).toBe('Pattern Not Found · AI Orchestration');
    });
  });
});
