// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — New Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the create-mode form shell
 * - "Create capability" submit button visible
 * - A failed categories load still renders the form, with a visible
 *   "Couldn't load" notice rather than a silently empty dropdown (#518)
 *
 * @see app/admin/orchestration/capabilities/new/page.tsx
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

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewCapabilityPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Create capability" submit button', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
    });
  });

  it('renders a form element', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    expect(document.querySelector('form')).toBeTruthy();
  });

  it('renders the name input field', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
    });
  });

  it('renders breadcrumb navigation links', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    expect(screen.getByRole('link', { name: /ai orchestration/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /capabilities/i })).toBeInTheDocument();
  });

  it('shows no load-failed notice when the categories load succeeds', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      '/api/v1/admin/orchestration/capabilities?page=1&limit=100'
    );
  });

  // ── A failed categories load is shown, not hidden (#518) ───────────────────

  describe('when the categories load fails', () => {
    it.each([
      ['the API answers 500', () => Promise.resolve(apiFailure(500))],
      ['the API answers success:false', () => Promise.resolve(apiFailure(200))],
      ['serverFetch rejects', () => Promise.reject(new Error('Network error'))],
    ])('still renders the form, with a notice, when %s', async (_label, answer) => {
      const { serverFetch } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockImplementation(answer);

      const { default: NewCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/new/page');

      render(await NewCapabilityPage());

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load existing capability categories/i
      );
      expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
    });
  });

  describe('category derivation', () => {
    it('filters out falsy categories (exercises filter(Boolean) predicate false arm)', async () => {
      // Arrange: capability list includes items with empty string and null categories.
      // The page does: data.map(c => c.category).filter(Boolean)
      // — the filter predicate's false arm fires for '' and null entries.
      const { serverFetch } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue(
        apiSuccess([
          { category: 'api' },
          { category: '' }, // falsy — filter removes this
          { category: 'search' },
          { category: null }, // falsy — filter removes this
        ])
      );

      const { default: NewCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/new/page');

      // Act
      const jsx = await NewCapabilityPage();
      render(jsx);

      // Assert: the page renders without throwing and the form is present.
      // The category prop is passed to CapabilityForm — we verify the page
      // renders correctly with filtered categories (no crash from falsy values).
      expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
    });
  });
});
