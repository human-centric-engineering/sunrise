/**
 * Integration Test: Admin Orchestration — New Evaluation Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/evaluations/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders "New Evaluation" heading
 * - Renders "Create Evaluation" button
 * - Graceful rendering when agent fetch fails (ok: false)
 * - No throw when serverFetch rejects
 *
 * @see app/admin/orchestration/evaluations/new/page.tsx
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
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({ success: true, data: MOCK_AGENTS });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({ success: true, data: MOCK_AGENTS });

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act
    render(await NewEvaluationPage());

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
    });
  });

  it('renders gracefully when agent fetch returns ok: false', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act: should not throw
    let thrown = false;
    try {
      render(await NewEvaluationPage());
    } catch {
      thrown = true;
    }

    // Assert: page renders with empty agents list (no crash)
    expect(thrown).toBe(false);
    expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
  });

  it('does not call logger.error when agent fetch returns ok: false (short-circuit, not catch)', async () => {
    // Arrange — ok: false triggers `if (!res.ok) return []` (line 24), NOT the catch block.
    // The catch block is the only place logger.error is called; the short-circuit is silent.
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { logger } = await import('@/lib/logging');

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act
    render(await NewEvaluationPage());

    // Assert: the !res.ok short-circuit returns [] silently — no error log
    expect(logger.error).not.toHaveBeenCalled();
    // And the page still renders with an empty agents list
    expect(screen.getByRole('heading', { name: /new evaluation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
  });

  it('renders gracefully when parseApiResponse returns success=false', async () => {
    // Covers the body.success === false branch of `return body.success ? body.data : [];`
    // — sibling of the !res.ok short-circuit. parseApiResponse returns successfully but
    // the body envelope reports failure (e.g., upstream service error surfaced as a
    // structured envelope rather than HTTP error).
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValueOnce({
      success: false,
      error: { message: 'Service degraded', code: 'SERVICE_ERROR' },
    });

    const { logger } = await import('@/lib/logging');

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    render(await NewEvaluationPage());

    // Same differentiator: this branch returns [] silently via the ternary. Only the
    // catch branch logs. If the ternary's else were removed and the code accessed
    // body.data when success=false, the page could fall into the catch and log.
    expect(logger.error).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /new evaluation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
  });

  it('does not throw when serverFetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: NewEvaluationPage } =
      await import('@/app/admin/orchestration/evaluations/new/page');

    // Act: should not throw
    render(await NewEvaluationPage());

    // Assert: structural stability — heading and submit button still render
    expect(screen.getByRole('heading', { name: /new evaluation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create evaluation/i })).toBeInTheDocument();
  });
});
