// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — New Evaluation Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders "New Evaluation" heading
 * - Renders "Create Evaluation" button
 * - A failed agent load (error status, error envelope, network error) throws
 *   to the error boundary rather than offering an empty agent dropdown (#518)
 *
 * @see app/admin/orchestration/evaluations/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'Bot Alpha' },
  { id: 'agent-2', name: 'Bot Beta' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewEvaluationPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "New Evaluation" heading', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_AGENTS));

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act
    render(await NewEvaluationPage());

    // Assert: heading in create mode
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /new evaluation/i })).toBeInTheDocument();
    });
  });

  it('renders "Create Evaluation" button', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_AGENTS));

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act
    render(await NewEvaluationPage());

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
    });
  });

  it('throws to the error boundary when the agent load fails', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act + Assert: no form with an empty agent dropdown
    await expect(NewEvaluationPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs the failure when the agent load fails', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(503, 'SERVICE_UNAVAILABLE'));
    const { logger } = await import('@/lib/logging');

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act
    await expect(NewEvaluationPage()).rejects.toThrow();

    // Assert: the failure is logged, with the path and status
    expect(logger.error).toHaveBeenCalledWith(
      'Server data load failed',
      undefined,
      expect.objectContaining({ status: 503, code: 'SERVICE_UNAVAILABLE' })
    );
  });

  it('throws to the error boundary when serverFetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act + Assert
    await expect(NewEvaluationPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
