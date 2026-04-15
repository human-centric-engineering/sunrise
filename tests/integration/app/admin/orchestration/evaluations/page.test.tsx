/**
 * Integration Test: Admin Orchestration — Evaluations List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid prisma response
 * - Renders evaluation titles from pre-fetched data
 * - Graceful empty state when prisma returns empty arrays
 * - No throw when prisma rejects
 *
 * @see app/admin/orchestration/evaluations/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationSession: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(),
    },
  },
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
    userId: 'user-1',
    summary: null,
    improvementSuggestions: null,
    agent: { id: 'agent-1', name: 'Test Agent', slug: 'test-agent' },
    _count: { logs: 3 },
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    completedAt: null,
    metadata: null,
  };
}

const MOCK_EVALUATIONS = [
  makeEvaluation('eval-1', 'Tone Check'),
  makeEvaluation('eval-2', 'Safety Audit'),
];

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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue(MOCK_EVALUATIONS as any);
    vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(2);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as any);

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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue(MOCK_EVALUATIONS as any);
    vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(2);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as any);

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

  it('renders empty state gracefully when prisma returns empty arrays', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEvaluationSession.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    const { default: EvaluationsListPage } =
      await import('@/app/admin/orchestration/evaluations/page');

    // Act: should not throw
    render(await EvaluationsListPage());

    // Assert: page renders (empty state in table)
    expect(screen.getByRole('heading', { name: /^evaluations$/i })).toBeInTheDocument();
    expect(screen.getByText(/no evaluations found/i)).toBeInTheDocument();
  });

  it('does not throw when prisma rejects', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiEvaluationSession.findMany).mockRejectedValue(new Error('Database error'));
    vi.mocked(prisma.aiEvaluationSession.count).mockRejectedValue(new Error('Database error'));
    vi.mocked(prisma.aiAgent.findMany).mockRejectedValue(new Error('Database error'));

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
