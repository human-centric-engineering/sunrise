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
    defaultTab,
    contextType,
    contextId,
  }: {
    patterns: { patternNumber: number }[];
    defaultTab?: string;
    contextType?: string;
    contextId?: string;
  }) => (
    <div
      data-testid="learning-tabs"
      data-patterns-count={String(patterns.length)}
      data-default-tab={defaultTab ?? ''}
      data-context-type={contextType ?? ''}
      data-context-id={contextId ?? ''}
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
    it('forwards loaded patterns and search params to LearningTabs', async () => {
      vi.mocked(serverFetch).mockResolvedValue(okResponse());
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: PATTERNS,
      } as never);
      const searchParams = Promise.resolve({
        tab: 'advisor',
        contextType: 'pattern',
        contextId: '1',
      });

      render(await LearnPage({ searchParams }));

      const tabs = screen.getByTestId('learning-tabs');
      expect(tabs).toHaveAttribute('data-patterns-count', '2');
      expect(tabs).toHaveAttribute('data-default-tab', 'advisor');
      expect(tabs).toHaveAttribute('data-context-type', 'pattern');
      expect(tabs).toHaveAttribute('data-context-id', '1');
    });

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
