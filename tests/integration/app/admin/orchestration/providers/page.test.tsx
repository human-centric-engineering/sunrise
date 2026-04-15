/**
 * Integration Test: Admin Orchestration — Providers List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading with valid prisma response
 * - Renders each provider card with correct names
 * - "+ Add provider" link present
 * - Graceful no-throw when prisma rejects
 *
 * @see app/admin/orchestration/providers/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProviderRow(id: string, name: string, opts: { isLocal?: boolean } = {}) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    providerType: 'anthropic',
    apiKeyEnvVar: 'SOME_API_KEY',
    baseUrl: null,
    isActive: true,
    isLocal: opts.isLocal ?? false,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    deletedAt: null,
    metadata: {},
  };
}

const MOCK_PROVIDER_ROWS = [
  makeProviderRow('prov-1', 'Anthropic'),
  makeProviderRow('prov-2', 'OpenAI'),
  makeProviderRow('prov-3', 'Ollama', { isLocal: true }),
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
    const { prisma } = await import('@/lib/db/client');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDER_ROWS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /^providers$/i })).toBeInTheDocument();
  });

  it('renders each provider name in a card', async () => {
    const { prisma } = await import('@/lib/db/client');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDER_ROWS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Ollama')).toBeInTheDocument();
    });
  });

  it('renders "+ Add provider" link', async () => {
    const { prisma } = await import('@/lib/db/client');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDER_ROWS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /add provider/i })).toBeInTheDocument();
    });
  });

  it('renders empty state when prisma returns empty array', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);

    const { default: ProvidersListPage } = await import('@/app/admin/orchestration/providers/page');

    render(await ProvidersListPage());

    expect(screen.getByRole('heading', { name: /^providers$/i })).toBeInTheDocument();
    expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument();
  });

  it('does not throw when prisma rejects', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiProviderConfig.findMany).mockRejectedValue(new Error('Database error'));

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
