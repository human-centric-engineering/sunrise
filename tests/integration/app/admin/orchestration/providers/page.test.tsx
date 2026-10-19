// @vitest-environment happy-dom

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
 * - A real empty provider list renders the empty state
 * - A failed providers load throws to the error boundary instead of
 *   rendering an empty list (#518)
 * - A failed model-matrix load leaves the Configuration tab working and
 *   shows a "Couldn't load" notice in the Model Matrix tab
 *
 * @see app/admin/orchestration/providers/page.tsx
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
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/providers'),
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

vi.mock('@/lib/orchestration/llm/known-providers', () => ({
  KNOWN_PROVIDERS: [
    {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      defaultBaseUrl: null,
      apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
      isLocal: false,
      suggestedDefaultChatModel: 'claude-sonnet-4-6',
      suggestedRoutingModel: null,
      suggestedReasoningModel: null,
      suggestedEmbeddingModel: null,
    },
  ],
  detectApiKeyEnvVar: vi.fn(() => 'ANTHROPIC_API_KEY'),
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

/** Answer the providers and provider-models fetches by path. */
async function mockApi(answers: { providers: () => Response; models: () => Response }) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) =>
    Promise.resolve(path.includes('/provider-models') ? answers.models() : answers.providers())
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProvidersListPage (server component)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useSearchParams } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Providers" heading', async () => {
    await mockApi({ providers: () => apiSuccess(MOCK_PROVIDERS), models: () => apiSuccess([]) });

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /providers/i })).toBeInTheDocument();
  });

  it('renders each provider name in a card', async () => {
    await mockApi({ providers: () => apiSuccess(MOCK_PROVIDERS), models: () => apiSuccess([]) });

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Ollama')).toBeInTheDocument();
    });
  });

  it('renders "+ Add provider" link', async () => {
    await mockApi({ providers: () => apiSuccess(MOCK_PROVIDERS), models: () => apiSuccess([]) });

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /add provider/i })).toBeInTheDocument();
    });
  });

  it('renders the empty state when no providers are configured', async () => {
    await mockApi({ providers: () => apiSuccess([]), models: () => apiSuccess([]) });

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /^providers$/i })).toBeInTheDocument();
    expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument();
  });

  it("requests both tabs' rows", async () => {
    await mockApi({ providers: () => apiSuccess([]), models: () => apiSuccess([]) });
    const { serverFetch } = await import('@/lib/api/server-fetch');

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');
    await ProvidersListPage();

    const paths = vi.mocked(serverFetch).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/admin/orchestration/providers?page=1&limit=50',
        '/api/v1/admin/orchestration/provider-models?page=1&limit=100&isActive=true',
      ])
    );
  });

  it('throws to the error boundary when the providers API answers 500', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    const { logger } = await import('@/lib/logging');
    await mockApi({ providers: () => apiFailure(500), models: () => apiSuccess([]) });

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    await expect(ProvidersListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  describe('when the model matrix fails to load', () => {
    it.each([
      ['answers 500', () => apiFailure(500)],
      ['answers success:false', () => apiFailure(200)],
    ])('still renders the providers when it %s', async (_label, models) => {
      await mockApi({ providers: () => apiSuccess(MOCK_PROVIDERS), models });

      const { default: ProvidersListPage } =
        await import('@/app/admin/orchestration/providers/page');
      render(await ProvidersListPage());

      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows a notice in the Model Matrix tab', async () => {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=models') as ReturnType<typeof useSearchParams>
      );
      await mockApi({ providers: () => apiSuccess(MOCK_PROVIDERS), models: () => apiFailure(500) });

      const { default: ProvidersListPage } =
        await import('@/app/admin/orchestration/providers/page');
      render(await ProvidersListPage());

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load the model matrix/i);
      expect(screen.getByRole('tab', { name: /configuration/i })).toBeInTheDocument();
    });
  });

  it('throws to the error boundary when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    await expect(ProvidersListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
