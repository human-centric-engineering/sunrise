/**
 * Integration Test: Admin Orchestration — Edit Provider Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Mock serverFetch for provider GET
 * - Asserts notFound() called when GET returns null
 * - Asserts form is pre-filled with fixture provider name
 *
 * @see app/admin/orchestration/providers/[id]/page.tsx
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: MOCK_PROVIDER });

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('My Anthropic Provider');
    });
  });

  it('renders "Save changes" button in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: MOCK_PROVIDER });

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input is pre-filled and disabled in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: MOCK_PROVIDER });

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    render(await EditProviderPage({ params: Promise.resolve({ id: 'prov-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('my-anthropic-provider');
      expect(slugInput).toBeDisabled();
    });
  });

  it('calls notFound() when provider fetch returns null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });

    const { default: EditProviderPage } =
      await import('@/app/admin/orchestration/providers/[id]/page');

    await expect(
      EditProviderPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });
});
