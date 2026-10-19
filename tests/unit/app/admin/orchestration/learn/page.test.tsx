// @vitest-environment happy-dom

/**
 * Unit Tests: LearnPage
 * (app/admin/orchestration/learn/page.tsx)
 *
 * Branch coverage targets:
 * - getPatterns: error status, error envelope or network error →
 *   ServerLoadError to the error boundary, never an empty catalogue (#518)
 * - getAgentBySlug: a failed lookup is logged and falls back to text-only chat
 * - Happy path: passes patterns and search params through to LearningTabs
 *
 * @see app/admin/orchestration/learn/page.tsx
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
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Answer = () => Promise<Response>;

const ok =
  (data: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data));

/**
 * Route the page's three parallel loads by URL: the pattern catalogue and the
 * two agent lookups. Each answer is a fresh `Response`, so bodies are never
 * read twice. Agents default to "none found".
 */
function wireFetches({
  patterns = ok(PATTERNS),
  advisor = ok([]),
  quiz = ok([]),
}: {
  patterns?: Answer;
  advisor?: Answer;
  quiz?: Answer;
} = {}): void {
  vi.mocked(serverFetch).mockImplementation((url: string) => {
    if (url.includes('pattern-advisor')) return advisor();
    if (url.includes('quiz-master')) return quiz();
    return patterns();
  });
}

const QUIZ_ROW = { id: 'agent-quiz', slug: 'quiz-master', isSystem: true, enableVoiceInput: false };

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

  describe('getPatterns failure', () => {
    it('throws to the error boundary when the pattern load fails', async () => {
      wireFetches({ patterns: () => Promise.resolve(apiFailure(500)) });

      await expect(LearnPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
        ServerLoadError
      );
    });

    it('throws to the error boundary when the API answers with an error envelope', async () => {
      wireFetches({
        patterns: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ success: false, error: { code: 'BOOM', message: 'parse failure' } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          ),
      });

      await expect(LearnPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
        ServerLoadError
      );
    });

    it('logs and throws when serverFetch throws', async () => {
      const fetchErr = new Error('Network down');
      wireFetches({ patterns: () => Promise.reject(fetchErr) });

      await expect(LearnPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
        ServerLoadError
      );
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed: no response',
        fetchErr,
        expect.objectContaining({ path: expect.stringContaining('/knowledge/patterns') })
      );
    });

    it('passes a real empty catalogue through to LearningTabs', async () => {
      wireFetches({ patterns: ok([]) });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-patterns-count', '0');
    });
  });

  describe('happy path', () => {
    it('forwards loaded patterns and context search params to LearningTabs', async () => {
      // The `tab` query param is no longer a page-level concern — the
      // LearningTabs client component reads it directly via useUrlTabs.
      // The page only forwards context props (contextType / contextId).
      wireFetches();
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
      wireFetches({
        advisor: ok([
          { id: 'agent-advisor', slug: 'pattern-advisor', isSystem: true, enableVoiceInput: true },
          // Substring match noise — `pattern-advisor-old` would be
          // returned by `?q=pattern-advisor`; the page must filter
          // for the exact slug.
          { id: 'agent-old', slug: 'pattern-advisor-old', isSystem: true, enableVoiceInput: false },
        ]),
        quiz: ok([QUIZ_ROW]),
      });

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
    // fetched: the chat still works, text-only. Each branch below proves
    // the data-advisor-* attributes collapse to '' for the affected tab.

    it('passes null advisorAgent and logs when the agent load fails', async () => {
      wireFetches({ advisor: () => Promise.resolve(apiFailure(500)), quiz: ok([QUIZ_ROW]) });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-id', '');
      expect(tabs).toHaveAttribute('data-advisor-voice', '');
      // Quiz still wired up — failure on one slug must not poison the
      // other.
      expect(tabs).toHaveAttribute('data-quiz-id', 'agent-quiz');
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed',
        undefined,
        expect.objectContaining({ path: expect.stringContaining('pattern-advisor'), status: 500 })
      );
    });

    it('passes null advisorAgent when no row matches the exact slug', async () => {
      // The agents list `?q=pattern-advisor` is substring, so it can
      // return a wrong-slug match. The page filters to exact and must
      // fall through to null when nothing matches.
      wireFetches({
        advisor: ok([
          {
            id: 'agent-old',
            slug: 'pattern-advisor-archived',
            isSystem: true,
            enableVoiceInput: true,
          },
        ]),
        quiz: ok([QUIZ_ROW]),
      });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-advisor-id', '');
    });

    it('passes null and logs when the agent fetch throws', async () => {
      const agentErr = new Error('Connection refused');
      wireFetches({ advisor: () => Promise.reject(agentErr), quiz: ok([QUIZ_ROW]) });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      // The loader logs the path (carrying the slug) and the error, so a
      // misconfigured deployment is visible in server logs.
      expect(logger.error).toHaveBeenCalledWith(
        'Server data load failed: no response',
        agentErr,
        expect.objectContaining({ path: expect.stringContaining('pattern-advisor') })
      );
      expect(screen.getByTestId('learning-tabs')).toHaveAttribute('data-advisor-id', '');
    });

    it('asks the list API for system agents only (§116 t-725)', async () => {
      // The list sorts system rows last, so filtering client-side after a
      // 10-row page could lose the platform instance behind the org's own
      // similarly-named agents.
      wireFetches();

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => String(url));
      const agentUrls = urls.filter((url) => url.includes('/orchestration/agents?'));
      expect(agentUrls).toHaveLength(2);
      for (const url of agentUrls) expect(url).toContain('isSystem=true');
    });

    it("ignores an org's own agent holding a platform slug (§116 t-725)", async () => {
      // An org that took `pattern-advisor` before the slug was reserved keeps
      // that agent; the Learn tab must not wire it up as the Pattern Advisor.
      wireFetches({
        advisor: ok([{ id: 'own-advisor', slug: 'pattern-advisor', isSystem: false }]),
        quiz: ok([{ id: 'agent-quiz', slug: 'quiz-master', isSystem: true }]),
      });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-id', '');
      expect(tabs).toHaveAttribute('data-quiz-id', 'agent-quiz');
    });

    it('defaults enableVoiceInput to false when the API row omits the field', async () => {
      // Older versions of the agents list may not surface the
      // `enableVoiceInput` field. Treat absence as voice-off rather
      // than throwing.
      wireFetches({
        advisor: ok([{ id: 'agent-advisor', slug: 'pattern-advisor', isSystem: true }]),
        quiz: ok([{ id: 'agent-quiz', slug: 'quiz-master', isSystem: true }]),
      });

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-advisor-voice', 'false');
      expect(tabs).toHaveAttribute('data-quiz-voice', 'false');
    });
  });

  describe('happy path (continued)', () => {
    it('renders the heading and breadcrumb back to AI Orchestration', async () => {
      wireFetches();

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/learning/i);
      expect(screen.getByRole('link', { name: 'AI Orchestration' })).toHaveAttribute(
        'href',
        '/admin/orchestration'
      );
    });

    it('renders the Antonio Gullí attribution line', async () => {
      wireFetches();

      render(await LearnPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByText(/agentic design patterns by antonio gullí/i)).toBeInTheDocument();
    });
  });
});
