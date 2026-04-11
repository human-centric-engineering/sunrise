/**
 * Integration Test: Admin Orchestration — New Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders create form with provider/model data hydrated
 * - Form renders in create mode with free-text fallback when fetches fail
 *
 * @see app/admin/orchestration/agents/new/page.tsx
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

const MOCK_PROVIDERS = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_KEY',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseUrl: null,
    description: null,
    metadata: {},
  },
];

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewAgentPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "New agent" heading in create mode', async () => {
    // Arrange: both provider and model fetches succeed
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');

    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
      .mockResolvedValueOnce({ success: true, data: MOCK_MODELS });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    // Act
    render(await NewAgentPage());

    // Assert: form is in create mode
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
    });
  });

  it('renders Create agent submit button', async () => {
    // Arrange
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
      .mockResolvedValueOnce({ success: true, data: MOCK_MODELS });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    // Act
    render(await NewAgentPage());

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
    });
  });

  it('renders with free-text fallback when provider fetch fails', async () => {
    // Arrange: provider fetch returns not-ok
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Fetch failed', code: 'FETCH_ERROR' },
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    // Act: should not throw
    let thrown = false;
    try {
      render(await NewAgentPage());
    } catch {
      thrown = true;
    }

    // Assert: page renders with fallback
    expect(thrown).toBe(false);
    expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
  });
});
