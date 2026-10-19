// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders form pre-filled with agent data in edit mode
 * - Calls notFound() on a 404, and only on a 404: a 500 throws to the error
 *   boundary instead (#518)
 * - A failed quarantine list / evaluation trend / profile list shows a
 *   "Couldn't load" notice in its place; the form still renders
 * - Provider / model failures keep the form's free-text fallback
 * - An inheriting agent shows the effective-defaults preview, not a selection
 *
 * @see app/admin/orchestration/agents/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

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

// `getEffectiveAgentDefaults` is the one helper on these pages that reads
// Prisma directly (provider + default-model lookups) rather than going through
// the mocked `serverFetch`. Stub it so the tests stay away from Prisma and each
// one controls the preview it asserts on. The other prefetch-helpers exports
// stay real.
vi.mock('@/lib/orchestration/prefetch-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/prefetch-helpers')>()),
  getEffectiveAgentDefaults: vi.fn(),
}));

/**
 * Default stub: the real contract for set fields (returned as-is, not
 * inherited) and the documented "nothing to inherit" result for empty ones.
 */
async function echoAgentDefaults(agent: { provider: string; model: string }) {
  return {
    provider: agent.provider,
    model: agent.model,
    inheritedProvider: agent.provider.length === 0,
    inheritedModel: agent.model.length === 0,
  };
}

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

// Provider-matrix rows, the shape `/provider-models` returns and
// `readProviderMatrixRows` parses — anything else is dropped and the form falls
// back to a free-text model box.
const MOCK_MODELS = [
  { providerSlug: 'anthropic', modelId: 'claude-opus-4-6', capabilities: ['chat'] },
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
    Promise.resolve(apiFailure(status, status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'));
const reject = (): Answer => () => Promise.reject(new Error('Network error'));

/**
 * The page makes ≥7 parallel `serverFetch` calls inside `Promise.all`
 * (agent + providers + 2× provider-models + evaluation-trend + profiles +
 * quarantined-capabilities). Answering by invocation order is
 * non-deterministic under load, so this dispatches on the path, with the
 * sub-resources checked before the agent itself (whose path prefixes them).
 */
async function mockApi({
  agent = ok(MOCK_AGENT),
  providers = ok(MOCK_PROVIDERS),
  models = ok(MOCK_MODELS),
  trend = ok({ points: [] }),
  profiles = ok([]),
  quarantined = ok({ items: [] }),
}: {
  agent?: Answer;
  providers?: Answer;
  models?: Answer;
  trend?: Answer;
  profiles?: Answer;
  quarantined?: Answer;
} = {}) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) => {
    if (path.includes('/evaluation-trend')) return trend();
    if (path.includes('/quarantined-capabilities')) return quarantined();
    if (path.includes('/agent-profiles')) return profiles();
    if (path.includes('/provider-models')) return models();
    if (path.includes('/providers')) return providers();
    return agent();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditAgentPage (server component)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    vi.mocked(getEffectiveAgentDefaults).mockImplementation(echoAgentDefaults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders agent name as heading in edit mode', async () => {
    await mockApi();

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
    });
  });

  it('shows "Save changes" button in edit mode', async () => {
    await mockApi();

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug field is pre-filled and disabled in edit mode', async () => {
    await mockApi();

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect((slugInput as HTMLInputElement).value).toBe('my-edit-agent');
      expect(slugInput).toBeDisabled();
    });
  });

  it('previews the resolved provider and model for an agent that inherits them', async () => {
    const { getEffectiveAgentDefaults } = await import('@/lib/orchestration/prefetch-helpers');
    await mockApi({ agent: ok({ ...MOCK_AGENT, provider: '', model: '' }) });
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inheritedProvider: true,
      inheritedModel: true,
    });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    // The page asks with the agent's own (empty) values…
    expect(getEffectiveAgentDefaults).toHaveBeenCalledWith({ provider: '', model: '' });

    // …and the hints show the stubbed resolution.
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /model/i }));
    expect(screen.getByText(/no provider of its own/i)).toHaveTextContent(/anthropic/i);
    expect(screen.getByText(/no model of its own/i)).toHaveTextContent(/claude-opus-4-6/i);
    // On edit the preview is shown, never selected — so picking it is a change.
    expect(screen.getByRole('combobox', { name: /provider/i })).toHaveTextContent(
      /pick a provider/i
    );
    // Same for the model. With no provider in form state the model dropdown is
    // the disabled no-models Select, and its hint would name any model held in
    // form state ("Saving now would keep …") — it names none.
    expect(screen.getByRole('combobox', { name: /^model/i })).toHaveTextContent(
      /no models registered/i
    );
    expect(screen.queryByText(/saving now would keep/i)).not.toBeInTheDocument();
  });

  it('calls notFound() when the agent does not exist', async () => {
    await mockApi({ agent: fail(404) });
    const { serverFetch } = await import('@/lib/api/server-fetch');

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    await expect(
      EditAgentPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(vi.mocked(serverFetch).mock.calls.map((c) => c[0])).toContain(
      '/api/v1/admin/orchestration/agents/nonexistent-id'
    );
  });

  it('throws to the error boundary, not notFound(), when the agent load fails', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockApi({ agent: fail(500) });

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    await expect(
      EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) })
    ).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  // ── Secondary panels (#518) ────────────────────────────────────────────────

  describe('secondary panel failures', () => {
    it('shows a notice in place of the quarantine banner when its load fails', async () => {
      await mockApi({ quarantined: fail(500) });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load quarantined capabilities/i
      );
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('shows a notice in place of the evaluation trend when its load fails', async () => {
      await mockApi({ trend: reject() });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load the evaluation trend/i);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    // The loader saw a success, so the page logs it: the notice says it was.
    it.each([
      ['quarantine', { quarantined: ok({}) }, /couldn.t load quarantined capabilities/i],
      ['trend', { trend: ok({}) }, /couldn.t load the evaluation trend/i],
    ])('shows and logs a %s reply with no list', async (_label, answers, notice) => {
      await mockApi(answers);
      const { logger } = await import('@/lib/logging');

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(notice);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('no list'),
        undefined,
        expect.objectContaining({ path: expect.any(String) })
      );
    });

    it('shows a notice when the profile list fails to load', async () => {
      await mockApi({ profiles: fail(500) });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load agent profiles/i);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('shows no notice when every panel loads', async () => {
      await mockApi();

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
      });
      expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
    });
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('provider/model fetch fallbacks', () => {
    it('renders with null providers when provider fetch rejects', async () => {
      await mockApi({ providers: reject() });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null providers when provider fetch answers 500', async () => {
      await mockApi({ providers: fail(500) });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null models when the model fetch answers success=false', async () => {
      await mockApi({ models: fail(200) });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });
  });
});
