/**
 * Integration Test: Admin Orchestration — Evaluations List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - Renders evaluation titles from pre-fetched data
 * - Graceful empty state when serverFetch returns not ok
 * - No throw when serverFetch rejects
 *
 * @see app/admin/orchestration/evaluations/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEvaluation(id: string, title: string) {
  return {
    id,
    title,
    status: 'draft',
    description: 'Test evaluation',
    agentId: 'agent-1',
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    _count: { logs: 3 },
    createdAt: new Date('2025-01-01').toISOString(),
  };
}

const MOCK_EVALUATIONS = [
  makeEvaluation('eval-1', 'Tone Check'),
  makeEvaluation('eval-2', 'Safety Audit'),
];

const MOCK_META = {
  page: 1,
  limit: 25,
  total: 2,
  totalPages: 1,
};

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'Test Agent' },
  { id: 'agent-2', name: 'Another Agent' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationsListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Evaluations heading and description', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_EVALUATIONS, meta: MOCK_META })
      .mockResolvedValueOnce({ success: true, data: MOCK_AGENTS, meta: undefined });

    // Import the page after mocks are set up
    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act: render server component (async)
    render(await EvaluationsListPage());

    // Assert: headings present
    expect(screen.getByRole('heading', { name: /^evaluations$/i })).toBeInTheDocument();
    expect(
      screen.getByText(/run agent evaluation sessions, annotate responses/i)
    ).toBeInTheDocument();
  });

  it('renders evaluation titles from pre-fetched data', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_EVALUATIONS, meta: MOCK_META })
      .mockResolvedValueOnce({ success: true, data: MOCK_AGENTS, meta: undefined });

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act
    render(await EvaluationsListPage());

    // Assert: evaluation titles appear (via EvaluationsTable)
    await waitFor(() => {
      expect(screen.getByText('Tone Check')).toBeInTheDocument();
      expect(screen.getByText('Safety Audit')).toBeInTheDocument();
    });
  });

  it('renders empty state gracefully when serverFetch returns not ok', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act: should not throw
    render(await EvaluationsListPage());

    // Assert: page renders (empty state in table)
    expect(screen.getByRole('heading', { name: /^evaluations$/i })).toBeInTheDocument();
    expect(screen.getByText(/no evaluations found/i)).toBeInTheDocument();
  });

  it('does not throw when serverFetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act: should not throw
    let thrown = false;
    try {
      render(await EvaluationsListPage());
    } catch {
      thrown = true;
    }

    // Assert
    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^evaluations$/i })).toBeInTheDocument();
  });
});
