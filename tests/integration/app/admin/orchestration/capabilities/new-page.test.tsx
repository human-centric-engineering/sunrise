/**
 * Integration Test: Admin Orchestration — New Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the create-mode form shell
 * - "Create capability" submit button visible
 * - Graceful render when serverFetch rejects (categories fall back to empty)
 *
 * @see app/admin/orchestration/capabilities/new/page.tsx
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
    });
  });

  it('renders a form element', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    expect(document.querySelector('form')).toBeTruthy();
  });

  it('renders the name input field', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [],
    });

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
    });
  });

  it('renders without throwing when categories fetch fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    let thrown = false;
    try {
      render(await NewCapabilityPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
  });

  it('renders breadcrumb navigation links', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: [] });

    const { default: NewCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/new/page');

    render(await NewCapabilityPage());

    expect(screen.getByRole('link', { name: /ai orchestration/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /capabilities/i })).toBeInTheDocument();
  });
});
