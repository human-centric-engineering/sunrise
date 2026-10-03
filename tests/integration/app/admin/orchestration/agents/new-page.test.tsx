// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — New Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders create form with provider/model data hydrated
 * - Form renders in create mode with free-text fallback when fetches fail
 * - The effective-defaults preview seeds the provider on create
 *
 * @see app/admin/orchestration/agents/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

  useSearchParams: () => ({ get: () => null }),
}));

// `getEffectiveAgentDefaults` reads Prisma directly (provider + default-model
// lookups) and swallows every failure, so left unmocked it silently waits on
// whatever database the machine has — or previews that developer's real rows.
// Stub it so each test fixes the preview it asserts on; the serverFetch-backed
// helpers in the same module stay real.
vi.mock('@/lib/orchestration/prefetch-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/prefetch-helpers')>()),
  getEffectiveAgentDefaults: vi.fn(),
}));

/** The documented "nothing to inherit" preview. */
const NOTHING_TO_INHERIT = {
  provider: '',
  model: '',
  inheritedProvider: true,
  inheritedModel: true,
};

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
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue(NOTHING_TO_INHERIT);
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

  it('starts the form on the effective-defaults preview the page resolved', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    // Two providers, previewing the second, so a selection can only have come
    // from the preview — not from the form defaulting to the first or only one.
    setupServerFetch(serverFetch as never, parseApiResponse as never, {
      '/provider-models': { data: MOCK_MODELS },
      '/providers': {
        data: [
          ...MOCK_PROVIDERS,
          { ...MOCK_PROVIDERS[0], id: 'prov-2', name: 'OpenAI', slug: 'openai' },
        ],
      },
    });
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'openai',
      model: 'claude-opus-4-6',
      inheritedProvider: true,
      inheritedModel: true,
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    // A new agent has nothing of its own, so the page asks for both.
    expect(getEffectiveAgentDefaults).toHaveBeenCalledWith({ provider: '', model: '' });

    // On create the preview is the starting value, so the fixture — not
    // whatever the test machine's database holds — selects the provider.
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /model/i }));
    expect(screen.getByRole('combobox', { name: /provider/i })).toHaveTextContent(/openai/i);
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

    it('renders correctly when agent-profiles parseApiResponse returns success=false', async () => {
      // Covers the body.success === false branch of `return body.success ? body.data : [];`
      // (sibling of the !res.ok short-circuit). parseApiResponse succeeds in returning,
      // but the body envelope reports failure — page must still render with profiles: [].
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      const { logger } = await import('@/lib/logging');

      setupServerFetch(serverFetch as never, parseApiResponse as never, {
        '/provider-models': { data: MOCK_MODELS },
        '/providers': { data: MOCK_PROVIDERS },
        '/agent-profiles': {
          success: false,
          error: { message: 'Profile service down', code: 'SERVICE_ERROR' },
        },
      });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
      // Same differentiator as the !res.ok test: this branch is silent (returns []
      // via the ternary). The catch branch is the only one that logs. If the ternary
      // were removed and body.data was accessed when success=false, the destructure
      // could explode (depends on the body shape), surfacing into the catch and logging.
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('renders correctly when agent-profiles fetch returns res.ok=false', async () => {
      // Covers the silent short-circuit `if (!res.ok) return [];` in getAgentProfiles().
      // Unlike the catch branch, this path does NOT call logger.error — that assertion
      // differentiates the two [] return paths: !res.ok (silent) vs catch (logged).
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      const { logger } = await import('@/lib/logging');

      // /provider-models and /providers succeed normally; /agent-profiles returns !ok.
      // Pattern length order: /agent-profiles (15) > /provider-models (15, tie but no
      // overlap) > /providers (10) — no collision risk.
      setupServerFetch(serverFetch as never, parseApiResponse as never, {
        '/provider-models': { data: MOCK_MODELS },
        '/providers': { data: MOCK_PROVIDERS },
        '/agent-profiles': { ok: false },
      });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      let thrown = false;
      try {
        render(await NewAgentPage());
      } catch {
        thrown = true;
      }

      // Page must not throw — the !res.ok guard silently returns [].
      expect(thrown).toBe(false);
      // Content assertions confirm the page rendered normally, not into an error state.
      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
      // logger.error must NOT have been called — proves the silent !res.ok branch fired,
      // not the catch branch (which logs). If the guard were removed and parseApiResponse
      // threw on a non-OK Response, the catch would log and this assertion would fail.
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
