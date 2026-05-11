/**
 * Unit Tests: LearnPage
 * (app/admin/orchestration/learn/page.tsx)
 *
 * Branch coverage targets:
 * - getPatterns: res.ok false → empty list
 * - getPatterns: body.success false → empty list
 * - getPatterns: serverFetch throws → empty list + logger.error
 * - Happy path: passes patterns and search params through to LearningTabs
 *
 * @see app/admin/orchestration/learn/page.tsx
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

vi.mock('@/components/admin/orchestration/learn/learning-tabs', () => ({
  LearningTabs: ({
    patterns,
    contextType,
    contextId,
    advisorAgent,
    quizAgent,
  }: {
    patterns: { patternNumber: number }[];
    contextType?: string;
    contextId?: string;
    advisorAgent?: { id: string; enableVoiceInput: boolean } | null;
    quizAgent?: { id: string; enableVoiceInput: boolean } | null;
  }) => (
    <div
      data-testid="learning-tabs"
      data-patterns-count={String(patterns.length)}
      data-context-type={contextType ?? ''}
      data-context-id={contextId ?? ''}
      data-advisor-id={advisorAgent?.id ?? ''}
      data-advisor-voice={advisorAgent ? String(advisorAgent.enableVoiceInput) : ''}
      data-quiz-id={quizAgent?.id ?? ''}
      data-quiz-voice={quizAgent ? String(quizAgent.enableVoiceInput) : ''}
    />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="field-help">{children}</span>
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import LearnPage from '@/app/admin/orchestration/learn/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function okResponse(): Response {
  return { ok: true } as Response;
}

function notOkResponse(): Response {
  return { ok: false } as Response;
}

const PATTERNS = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'Reasoning',
    description: 'Step-by-step reasoning.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'ReAct',
    category: 'Action',
    description: 'Reasoning + acting.',
    chunkCount: 4,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LearnPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPatterns error branches', () => {
    it('passes an empty patterns list to LearningTabs when res.ok is false', async () => {
      vi.mocked(serverFetch).mockResolvedValue(notOkResponse());
      const searchParams = Promise.resolve({});

      render(await LearnPage({ searchParams }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-patterns-count', '0');
      expect(parseApiResponse).not.toHaveBeenCalled();
    });

    it('passes an empty patterns list when body.success is false', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'BOOM', message: 'parse failure' },
      } as never);
      const searchParams = Promise.resolve({});

      render(await LearnPage({ searchParams }));

      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-patterns-count', '0');
    });

    it('logs and renders an empty list when serverFetch throws', async () => {
      const fetchErr = new Error('Network down');
      vi.mocked(serverFetch).mockRejectedValue(fetchErr);
      const searchParams = Promise.resolve({});

      render(await LearnPage({ searchParams }));

      expect(logger.error).toHaveBeenCalledWith('learn page: pattern fetch failed', fetchErr);
      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-patterns-count', '0');
    });
  });

  describe('happy path', () => {
    it('forwards loaded patterns and context search params to LearningTabs', async () => {
      // The `tab` query param is no longer a page-level concern — the
      // LearningTabs client component reads it directly via useUrlTabs.
      // The page only forwards context props (contextType / contextId).
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: PATTERNS,
      } as never);
      const searchParams = Promise.resolve({
        contextType: 'pattern',
        contextId: '1',
      });

      render(await LearnPage({ searchParams }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-patterns-count', '2');
      expect(tabs).toHaveAttribute('data-context-type', 'pattern');
      expect(tabs).toHaveAttribute('data-context-id', '1');
    });

    it('forwards advisor + quiz agent metadata when the API returns matching rows', async () => {
      // Page fires three parallel serverFetch calls: patterns,
      // pattern-advisor agent, quiz-master agent. The first returns
      // patterns; the next two return agent list pages we filter to
      // the exact slug. Stubbing `mockResolvedValue` returns the same
      // ok-response for every call — what matters is the parseApiResponse
      // sequence, which mirrors the call order.
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: PATTERNS } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [
            { id: 'agent-advisor', slug: 'pattern-advisor', enableVoiceInput: true },
            // Substring match noise — `pattern-advisor-old` would be
            // returned by `?q=pattern-advisor`; the page must filter
            // for the exact slug.
            { id: 'agent-old', slug: 'pattern-advisor-old', enableVoiceInput: false },
          ],
        } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-quiz', slug: 'quiz-master', enableVoiceInput: false }],
        } as never);

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-id', 'agent-advisor');
      expect(tabs).toHaveAttribute('data-advisor-voice', 'true');
      expect(tabs).toHaveAttribute('data-quiz-id', 'agent-quiz');
      expect(tabs).toHaveAttribute('data-quiz-voice', 'false');
    });
  });

  describe('getAgentBySlug error branches', () => {
    // The page hides the mic affordance when agent metadata can't be
    // fetched. Each branch below proves the data-advisor-* attributes
    // collapse to '' so the LearningTabs render falls back to text-
    // only chat for the affected tab.

    it('passes null advisorAgent when the agent fetch returns !res.ok', async () => {
      // First call (patterns) ok; second call (pattern-advisor)
      // !res.ok; third call (quiz-master) ok with a real row.
      vi.mocked(serverFetch)
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(notOkResponse())
        .mockResolvedValueOnce(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: PATTERNS } as never)
        // No parseApiResponse for the !res.ok branch — the route
        // returns early. The quiz call still goes through.
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-quiz', slug: 'quiz-master', enableVoiceInput: false }],
        } as never);

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-id', '');
      expect(tabs).toHaveAttribute('data-advisor-voice', '');
      // Quiz still wired up — failure on one slug must not poison the
      // other.
      expect(tabs).toHaveAttribute('data-quiz-id', 'agent-quiz');
    });

    it('passes null advisorAgent when no row matches the exact slug', async () => {
      // The agents list `?q=pattern-advisor` is substring, so it can
      // return a wrong-slug match. The page filters to exact and must
      // fall through to null when nothing matches.
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: PATTERNS } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [
            // Substring matches like `pattern-advisor-archived`
            // but the exact `pattern-advisor` slug is not present.
            { id: 'agent-old', slug: 'pattern-advisor-archived', enableVoiceInput: true },
          ],
        } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-quiz', slug: 'quiz-master', enableVoiceInput: false }],
        } as never);

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-advisor-id', '');
    });

    it('passes null and logs when the agent fetch throws', async () => {
      const agentErr = new Error('Connection refused');
      vi.mocked(serverFetch)
        .mockResolvedValueOnce(okResponse())
        .mockRejectedValueOnce(agentErr)
        .mockResolvedValueOnce(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: PATTERNS } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-quiz', slug: 'quiz-master', enableVoiceInput: false }],
        } as never);

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      // The catch in getAgentBySlug logs with the slug + err so a
      // misconfigured deployment is visible in server logs.
      expect(logger.error).toHaveBeenCalledWith(
        'learn page: agent fetch failed',
        expect.objectContaining({ slug: 'pattern-advisor' })
      );
      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-advisor-id', '');
    });

    it('defaults enableVoiceInput to false when the API row omits the field', async () => {
      // Older versions of the agents list may not surface the
      // `enableVoiceInput` field. Treat absence as voice-off rather
      // than throwing.
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: PATTERNS } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-advisor', slug: 'pattern-advisor' }],
        } as never)
        .mockResolvedValueOnce({
          success: true,
          data: [{ id: 'agent-quiz', slug: 'quiz-master' }],
        } as never);

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-voice', 'false');
      expect(tabs).toHaveAttribute('data-quiz-voice', 'false');
    });
  });

  describe('happy path (continued)', () => {
    it('renders the heading and breadcrumb back to AI Orchestration', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: PATTERNS,
      } as never);
      const searchParams = Promise.resolve({});

      render(await LearnPage({ searchParams }));

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/learning/i);
      expect(screen.getByRole('link', { name: 'AI Orchestration' })).toHaveAttribute(
        'href',
        '/admin/orchestration'
      );
    });

    it('renders the Antonio Gullí attribution line', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: PATTERNS,
      } as never);
      const searchParams = Promise.resolve({});

      render(await LearnPage({ searchParams }));

      expect(screen.getByText(/agentic design patterns by antonio gullí/i)).toBeInTheDocument();
    });
  });
});
