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

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * URL-aware fetch dispatch. The page makes ≥3 parallel `serverFetch`
 * calls inside `Promise.all` (providers + 2× provider-models + profiles).
 * The previous `mockResolvedValueOnce` queue pattern matched by invocation
 * order, which is non-deterministic under load and intermittently mismatched
 * the providers response onto a different fetch.
 *
 * Dispatch on URL substring + sort patterns by length descending so
 * `/provider-models` beats `/providers` when both could match.
 */
type EndpointResponse = { ok?: boolean; success?: boolean; data?: unknown; error?: unknown };
function setupServerFetch(
  serverFetch: ReturnType<typeof vi.fn>,
  parseApiResponse: ReturnType<typeof vi.fn>,
  routes: Record<string, EndpointResponse>
): void {
  const patterns = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const dispatch = (url: string | URL): Response => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, resp] of patterns) {
      if (urlStr.includes(pattern)) {
        if (resp.ok === false) return { ok: false } as Response;
        const body = JSON.stringify({
          success: resp.success !== false,
          data: resp.data,
          ...(resp.error ? { error: resp.error } : {}),
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  vi.mocked(serverFetch).mockImplementation(((url: string | URL) =>
    Promise.resolve(dispatch(url))) as never);
  vi.mocked(parseApiResponse).mockImplementation(((res: Response) => {
    if (!res.ok)
      return Promise.resolve({ success: false, error: { message: 'not ok', code: 'NOT_OK' } });
    return res.json();
  }) as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewAgentPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "New agent" heading in create mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/provider-models': { data: MOCK_MODELS },
      '/providers': { data: MOCK_PROVIDERS },
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
    });
  });

  it('renders Create agent submit button', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/provider-models': { data: MOCK_MODELS },
      '/providers': { data: MOCK_PROVIDERS },
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
    });
  });

  it('renders with free-text fallback when provider fetch fails', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    // All fetches return !ok → page falls back to free-text inputs
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/provider-models': { ok: false },
      '/providers': { ok: false },
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    let thrown = false;
    try {
      render(await NewAgentPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    // The form contains both a submit `<button type=submit>` and a top-of-page
    // "Create agent" heading link in some contexts. Match the submit button
    // specifically to avoid false multiples.
    expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('fallback branches', () => {
    it('renders correctly when serverFetch rejects (network error)', async () => {
      const { serverFetch } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });

    it('renders correctly when provider fetch returns res.ok=false', async () => {
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      // /providers fails; /provider-models succeeds. URL-aware dispatch is
      // order-safe even though they share a prefix because longest-pattern wins.
      setupServerFetch(serverFetch as never, parseApiResponse as never, {
        '/provider-models': { data: MOCK_MODELS },
        '/providers': { ok: false },
      });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });

    it('renders correctly when model parseApiResponse returns success=false', async () => {
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      setupServerFetch(serverFetch as never, parseApiResponse as never, {
        '/provider-models': {
          success: false,
          error: { message: 'Registry error', code: 'SERVICE_ERROR' },
        },
        '/providers': { data: MOCK_PROVIDERS },
      });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });
  });
});
