/**
 * Integration Test: Admin Orchestration — Evaluation Detail Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders evaluation title as heading when found
 * - Calls notFound() when fetch returns ok: false
 * - Calls notFound() when serverFetch rejects
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EVALUATION = {
  id: 'eval-edit-id',
  title: 'My Tone Check',
  description: 'Checks the tone of responses',
  status: 'draft',
  summary: null,
  improvementSuggestions: null,
  agent: { id: 'agent-1', name: 'Bot Alpha', slug: 'bot-alpha' },
  createdAt: new Date('2025-01-01').toISOString(),
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: true,
      data: MOCK_EVALUATION,
    });

    const { default: EvaluationDetailPage } =
      await import('@/app/admin/orchestration/evaluations/[id]/page');

    // Act
    render(await EvaluationDetailPage({ params: Promise.resolve({ id: 'eval-edit-id' }) }));

    // Assert: evaluation title rendered as heading
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /my tone check/i })).toBeInTheDocument();
    });
  });

  it('calls notFound() when fetch returns ok: false', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });

    const { default: EvaluationDetailPage } =
      await import('@/app/admin/orchestration/evaluations/[id]/page');

    // Act: notFound() throws NEXT_NOT_FOUND
    await expect(
      EvaluationDetailPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    // Assert: notFound was called
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('calls notFound() when serverFetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

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
