// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders form pre-filled with agent data in edit mode
 * - Calls notFound() when agent is null
 * - Previews the provider/model the stubbed effective-defaults helper resolves for an
 *   agent with none of its own
 *
 * @see app/admin/orchestration/agents/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

  useSearchParams: () => ({ get: () => null }),
}));

// `getEffectiveAgentDefaults` reads `aiProviderConfig` and the orchestration
// settings straight from Prisma whenever the agent leaves provider or model
// empty. Left real, such an agent's preview comes from whatever database the
// machine has (a 10 s connect timeout when there is none, the developer's own
// provider rows when there is). Stub it so each test fixes the preview it
// asserts on; the other helpers stay real because these tests drive them
// through `serverFetch`.
vi.mock('@/lib/orchestration/prefetch-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/prefetch-helpers')>()),
  getEffectiveAgentDefaults: vi.fn(),
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

const MOCK_AGENT = {
  id: 'agent-edit-id',
  name: 'My Edit Agent',
  slug: 'my-edit-agent',
  description: 'Helps with editing',
  systemInstructions: 'You are a helpful editor.',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  monthlyBudgetUsd: null,
  isActive: true,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  systemInstructionsHistory: [],
  metadata: {},
  deletedAt: null,
};

const MOCK_PROVIDERS = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_KEY',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    description: null,
    metadata: {},
  },
];

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * The page makes ≥6 parallel `serverFetch` calls inside `Promise.all`
 * (agent + providers + 2× provider-models + evaluation-trend + profiles).
 * The previous `mockResolvedValueOnce` queue pattern matched responses by
 * invocation order, which is non-deterministic under load — under the
 * full test suite it could drift, causing the wrong response to land on
 * the agent fetch and crashing downstream code (e.g. `agent.provider`
 * undefined → TypeError in getEffectiveAgentDefaults).
 *
 * This helper dispatches on URL substring so order doesn't matter.
 * `parseApiResponse` is then mocked to read the JSON body of whatever
 * Response it receives, preserving end-to-end fidelity.
 */
type EndpointResponse = { ok?: boolean; success?: boolean; data?: unknown; error?: unknown };
function setupServerFetch(
  serverFetch: ReturnType<typeof vi.fn>,
  parseApiResponse: ReturnType<typeof vi.fn>,
  routes: Record<string, EndpointResponse>
): void {
  // Sort by pattern length descending so the most specific pattern wins —
  // otherwise `/providers` would also match `/provider-models`.
  const patterns = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const dispatch = (url: string | URL): Response => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, resp] of patterns) {
      if (urlStr.includes(pattern)) {
        const body = JSON.stringify({
          success: resp.success !== false,
          data: resp.data,
          ...(resp.error ? { error: resp.error } : {}),
        });
        return new Response(body, {
          status: resp.ok === false ? 500 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // Safe default for unspecified endpoints (e.g. evaluation-trend, profiles)
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

describe('EditAgentPage (server component)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    // An agent with its own provider and model inherits nothing.
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: MOCK_AGENT.provider,
      model: MOCK_AGENT.model,
      inheritedProvider: false,
      inheritedModel: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders agent name as heading in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/agents/agent-edit-id': { data: MOCK_AGENT },
      '/providers': { data: MOCK_PROVIDERS },
      '/provider-models': { data: MOCK_MODELS },
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
    });
  });

  it('shows "Save changes" button in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/agents/agent-edit-id': { data: MOCK_AGENT },
      '/providers': { data: MOCK_PROVIDERS },
      '/provider-models': { data: MOCK_MODELS },
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug field is pre-filled and disabled in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/agents/agent-edit-id': { data: MOCK_AGENT },
      '/providers': { data: MOCK_PROVIDERS },
      '/provider-models': { data: MOCK_MODELS },
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect((slugInput as HTMLInputElement).value).toBe('my-edit-agent');
      expect(slugInput).toBeDisabled();
    });
  });

  it('previews the inherited provider the helper resolves for an agent with none of its own', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/agents/agent-edit-id': { data: { ...MOCK_AGENT, provider: '', model: '' } },
      '/providers': { data: MOCK_PROVIDERS },
      '/provider-models': { data: MOCK_MODELS },
    });
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'fixture-provider',
      model: 'fixture-model',
      inheritedProvider: true,
      inheritedModel: true,
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    expect(getEffectiveAgentDefaults).toHaveBeenCalledWith({ provider: '', model: '' });
    await userEvent.setup().click(screen.getByRole('tab', { name: /model/i }));
    // The preview is the fixture, not whatever providers the local database holds.
    expect(screen.getByText(/no provider of its own/i)).toHaveTextContent(/fixture-provider/);
    expect(screen.getByText(/no model of its own/i)).toHaveTextContent(/fixture-model/);
  });

  it('calls notFound() when agent fetch returns null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/agents/nonexistent-id': {
        ok: false,
        success: false,
        error: { message: 'Not found', code: 'NOT_FOUND' },
      },
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    await expect(
      EditAgentPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('provider/model fetch fallbacks', () => {
    it('renders with null providers when provider fetch rejects', async () => {
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      // URL-aware mock: the provider fetch throws, everything else succeeds.
      vi.mocked(serverFetch).mockImplementation((url: string | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/providers') && !urlStr.includes('provider-models')) {
          return Promise.reject(new Error('Network error'));
        }
        const body = (data: unknown): Response =>
          new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        if (urlStr.includes('/agents/agent-edit-id')) return Promise.resolve(body(MOCK_AGENT));
        if (urlStr.includes('/provider-models')) return Promise.resolve(body(MOCK_MODELS));
        return Promise.resolve(body([]));
      });
      vi.mocked(parseApiResponse).mockImplementation(((res: Response) => res.json()) as never);

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null providers when provider fetch returns res.ok=false', async () => {
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      // /providers and /provider-models share a prefix, so use explicit URL
      // matching instead of substring-based setupServerFetch.
      vi.mocked(serverFetch).mockImplementation((url: string | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const body = (data: unknown): Response =>
          new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        if (urlStr.includes('/agents/agent-edit-id')) return Promise.resolve(body(MOCK_AGENT));
        if (urlStr.includes('/provider-models')) return Promise.resolve(body(MOCK_MODELS));
        if (urlStr.endsWith('/admin/orchestration/providers')) {
          return Promise.resolve({ ok: false } as Response);
        }
        return Promise.resolve(body([]));
      });
      vi.mocked(parseApiResponse).mockImplementation(((res: Response) => {
        if (!res.ok)
          return Promise.resolve({ success: false, error: { message: 'not ok', code: 'NOT_OK' } });
        return res.json();
      }) as never);

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null models when model parseApiResponse returns success=false', async () => {
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      setupServerFetch(serverFetch as never, parseApiResponse as never, {
        '/agents/agent-edit-id': { data: MOCK_AGENT },
        '/provider-models': {
          success: false,
          error: { message: 'Registry unavailable', code: 'SERVICE_ERROR' },
        },
        '/providers': { data: MOCK_PROVIDERS },
      });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });
  });
});
