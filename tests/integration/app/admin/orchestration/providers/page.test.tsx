/**
 * Integration Test: Admin Orchestration — Providers List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading with valid serverFetch response
 * - Renders each provider card with correct names
 * - "+ Add provider" link present
 * - Graceful no-throw when fetch rejects
 *
 * @see app/admin/orchestration/providers/page.tsx
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
  useSearchParams: vi.fn(() => ({ get: vi.fn(() => null) })),
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

function makeProvider(
  id: string,
  name: string,
  opts: { apiKeyPresent: boolean; isLocal?: boolean }
) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    providerType: 'anthropic',
    apiKeyEnvVar: 'SOME_API_KEY',
    baseUrl: null,
    isActive: true,
    isLocal: opts.isLocal ?? false,
    apiKeyPresent: opts.apiKeyPresent,
    createdBy: 'system',
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
    deletedAt: null,
    metadata: {},
  };
}

const MOCK_PROVIDERS = [
  makeProvider('prov-1', 'Anthropic', { apiKeyPresent: true }),
  makeProvider('prov-2', 'OpenAI', { apiKeyPresent: false }),
  makeProvider('prov-3', 'Ollama', { apiKeyPresent: false, isLocal: true }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProvidersListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Providers" heading', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    // First call: providers; second call: models
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS } as never)
      .mockResolvedValueOnce({ success: true, data: [] } as never);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /providers/i })).toBeInTheDocument();
  });

  it('renders each provider name in a card', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS } as never)
      .mockResolvedValueOnce({ success: true, data: [] } as never);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Ollama')).toBeInTheDocument();
    });
  });

  it('renders "+ Add provider" link', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS } as never)
      .mockResolvedValueOnce({ success: true, data: [] } as never);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /add provider/i })).toBeInTheDocument();
    });
  });

  it('renders empty state when fetch returns not ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /^providers$/i })).toBeInTheDocument();
    expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument();
  });

  it('does not throw when fetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    let thrown = false;
    try {
      render(await ProvidersListPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^providers$/i })).toBeInTheDocument();
  });
});
