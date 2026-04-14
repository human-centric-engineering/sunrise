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
