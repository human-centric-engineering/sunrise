// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Provider Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Mock serverFetch for provider GET
 * - Asserts notFound() is called on a 404, and only on a 404: a 500 throws
 *   to the error boundary instead of reading as a missing provider (#518)
 * - Asserts form is pre-filled with fixture provider name
 *
 * @see app/admin/orchestration/providers/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { apiFailure, apiSuccess, apiIdRejected } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PROVIDER = {
  id: 'prov-edit-id',
  name: 'My Anthropic Provider',
  slug: 'my-anthropic-provider',
  providerType: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  baseUrl: null,
  isActive: true,
  isLocal: false,
  apiKeyPresent: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  deletedAt: null,
  metadata: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditProviderPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form pre-filled with provider name', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_PROVIDER));

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('My Anthropic Provider');
    });
  });

  it('renders "Save changes" button in edit mode', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_PROVIDER));

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input is pre-filled and disabled in edit mode', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_PROVIDER));

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('my-anthropic-provider');
      expect(slugInput).toBeDisabled();
    });
  });

  it('calls notFound() when the provider does not exist', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(404, 'NOT_FOUND'));

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    await expect(
      EditProviderPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('calls notFound() for a malformed id, which the API answers 400', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiIdRejected());

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    await expect(
      EditProviderPage({ params: Promise.resolve({ id: 'not-a-cuid' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('throws to the error boundary, not notFound(), when the load fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    await expect(
      EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
