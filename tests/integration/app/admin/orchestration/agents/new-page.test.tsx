// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — New Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the create form from the prefetched providers and model matrix
 * - Form renders in create mode with free-text fallback when provider/model fetches fail
 * - A failed profile list shows a "Couldn't load" notice above the form (#518)
 * - The effective-defaults preview seeds the provider and model on create
 *
 * @see app/admin/orchestration/agents/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

// `getEffectiveAgentDefaults` is the one helper on these pages that reads
// Prisma directly (provider + default-model lookups) rather than going through
// the mocked `serverFetch`. Stub it so the tests stay away from Prisma and each
// one controls the preview it asserts on. The other prefetch-helpers exports
// stay real.
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
  {
    id: 'prov-2',
    name: 'OpenAI',
    slug: 'openai',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseUrl: null,
    description: null,
    metadata: {},
  },
];

// Provider-matrix rows, the shape `/provider-models` returns and
// `readProviderMatrixRows` parses — anything else is dropped and the form falls
// back to a free-text model box.
const MOCK_MODELS = [
  { providerSlug: 'anthropic', modelId: 'claude-opus-4-6', capabilities: ['chat'] },
  { providerSlug: 'openai', modelId: 'gpt-4o-mini', capabilities: ['chat'] },
  { providerSlug: 'openai', modelId: 'gpt-4o', capabilities: ['chat'] },
];

// ─── Test helpers ─────────────────────────────────────────────────────────────

type Answer = () => Promise<Response>;

const ok =
  (data: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data));
const fail =
  (status = 500): Answer =>
  () =>
    Promise.resolve(apiFailure(status));
const reject = (): Answer => () => Promise.reject(new Error('Network error'));

/**
 * URL-aware fetch dispatch. The page makes ≥4 parallel `serverFetch` calls
 * inside `Promise.all` (providers + 2× provider-models + profiles), so
 * answering by invocation order is non-deterministic under load.
 * `/provider-models` is checked before `/providers`, which prefixes it.
 */
async function mockApi({
  providers = ok(MOCK_PROVIDERS),
  models = ok(MOCK_MODELS),
  profiles = ok([]),
}: { providers?: Answer; models?: Answer; profiles?: Answer } = {}) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) => {
    if (path.includes('/agent-profiles')) return profiles();
    if (path.includes('/provider-models')) return models();
    return providers();
  });
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
    await mockApi();

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
    });
  });

  it('renders Create agent submit button', async () => {
    await mockApi();

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
    });
  });

  it('starts the form on the effective-defaults preview the page resolved', async () => {
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    // Preview the SECOND provider, so a selection can only have come from the
    // preview — not from the form defaulting to the first or only one.
    await mockApi();
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      inheritedProvider: true,
      inheritedModel: true,
    });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    // A new agent has nothing of its own, so the page asks for both.
    expect(getEffectiveAgentDefaults).toHaveBeenCalledWith({ provider: '', model: '' });

    // On create the preview is the starting value, so it selects the provider…
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /model/i }));
    expect(screen.getByRole('combobox', { name: /provider/i })).toHaveTextContent(/openai/i);
    // …and the model with it, as a pair. openai's SECOND model, because the form
    // picks a provider's first model when none is set.
    const modelSelect = screen.getByRole('combobox', { name: /^model/i });
    expect(modelSelect).toHaveTextContent(/gpt-4o/i);
    expect(modelSelect).not.toHaveTextContent(/gpt-4o-mini/i);
  });

  it('renders with free-text fallback when provider and model fetches fail', async () => {
    // Providers and models answer 500 → the form falls back to free-text inputs
    await mockApi({ providers: fail(500), models: fail(500) });

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    // The form contains both a submit `<button type=submit>` and a top-of-page
    // "Create agent" heading link in some contexts. Match the submit button
    // specifically to avoid false multiples.
    expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
  });

  it('shows no load-failed notice when every fetch succeeds', async () => {
    await mockApi();

    const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

    render(await NewAgentPage());

    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('fallback branches', () => {
    it('renders correctly when serverFetch rejects (network error)', async () => {
      await mockApi({ providers: reject(), models: reject(), profiles: reject() });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });

    it('renders correctly when the provider fetch answers 500', async () => {
      await mockApi({ providers: fail(500) });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });

    it('renders correctly when the model fetch answers success=false', async () => {
      await mockApi({ models: fail(200) });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('heading', { name: /new agent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
    });

    // A failed profile list is shown, logged, and the form still works (#518).
    it.each([
      ['answers success=false', fail(200)],
      ['answers 500', fail(500)],
      ['rejects', reject()],
    ])('shows a notice when the agent-profiles fetch %s', async (_label, profiles) => {
      const { logger } = await import('@/lib/logging');
      await mockApi({ profiles });

      const { default: NewAgentPage } = await import('@/app/admin/orchestration/agents/new/page');

      render(await NewAgentPage());

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load agent profiles/i);
      expect(screen.getByRole('button', { name: /^create agent$/i })).toBeInTheDocument();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
