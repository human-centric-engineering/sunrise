/**
 * Integration Test: Admin Orchestration — Evaluation Detail Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders evaluation title as heading when found
 * - Calls notFound() when prisma returns null
 * - Calls notFound() when prisma rejects
 *
 * @see app/admin/orchestration/evaluations/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationSession: {
      findFirst: vi.fn(),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EVALUATION_ROW = {
  id: 'eval-edit-id',
  title: 'My Tone Check',
  description: 'Checks the tone of responses',
  status: 'draft',
  summary: null,
  improvementSuggestions: null,
  agentId: 'agent-1',
  userId: 'test-user-id',
  agent: { id: 'agent-1', name: 'Bot Alpha', slug: 'bot-alpha' },
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  completedAt: null,
  metadata: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationDetailPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // EvaluationRunner fires a PATCH on mount for draft evaluations.
    // Stub global.fetch so that the rendered component does not cause
    // unhandled network errors in the test environment.
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders evaluation title as heading when found', async () => {
    // Arrange
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(MOCK_EVALUATION_ROW as any);

    const { default: EvaluationDetailPage } =
      await import('@/app/admin/orchestration/evaluations/[id]/page');

    // Act
    render(await EvaluationDetailPage({ params: Promise.resolve({ id: 'eval-edit-id' }) }));

    // Assert: evaluation title rendered as heading
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /my tone check/i })).toBeInTheDocument();
    });
  });

  it('calls notFound() when prisma returns null', async () => {
    // Arrange
    const { getServerSession } = await import('@/lib/auth/utils');
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'test-user-id', role: 'ADMIN' },
    } as any);
    vi.mocked(prisma.aiEvaluationSession.findFirst).mockResolvedValue(null);

    const { default: EvaluationDetailPage } =
      await import('@/app/admin/orchestration/evaluations/[id]/page');

    // Act: notFound() throws NEXT_NOT_FOUND
    await expect(
      EvaluationDetailPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    // Assert: notFound was called
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('calls notFound() when session is missing (userId is undefined)', async () => {
    // Arrange: no session → userId is undefined → evaluation stays null
    const { getServerSession } = await import('@/lib/auth/utils');
    vi.mocked(getServerSession).mockResolvedValue(null);

    const { default: EvaluationDetailPage } =
      await import('@/app/admin/orchestration/evaluations/[id]/page');

    // Act: evaluation returns null → notFound() is called
    await expect(
      EvaluationDetailPage({ params: Promise.resolve({ id: 'some-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    // Assert
    expect(mockNotFound).toHaveBeenCalledOnce();
  });
});
