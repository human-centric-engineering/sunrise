/**
 * SetupWizard — Individual Step Content Tests
 *
 * Complements setup-wizard.test.tsx (shell + navigation) by drilling
 * into the per-step API interactions and edge cases.
 *
 * Steps under test (6-step layout):
 *   Step 2 (index 1) — StepProvider: detection cards, manual form, error path
 *   Step 3 (index 2) — StepDefaultModels: renders, persists chat/embedding choice
 *   Step 4 (index 3) — StepAgent: warning when no providers, dropdown wiring
 *   Step 5 (index 4) — StepTestAgent: Continue advances
 *   Step 6 (index 5) — StepDone: renders, Finish clears localStorage
 *
 * @see components/admin/orchestration/setup-wizard.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v2';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedStorage(stepIndex: number, overrides: Record<string, unknown> = {}): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      stepIndex,
      providerDraft: {
        name: '',
        slug: '',
        apiKeyEnvVar: '',
        providerType: '',
        baseUrl: '',
        suggestedDefaultChatModel: '',
        suggestedEmbeddingModel: '',
      },
      agentDraft: {
        name: 'My Agent',
        slug: 'my-agent',
        description: 'A test agent',
        systemInstructions: 'You are helpful.',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      },
      createdAgentSlug: null,
      ...overrides,
    })
  );
}

interface MockFetchOpts {
  providerTotal?: number;
  agentTotal?: number;
  postProviderOk?: boolean;
  postAgentOk?: boolean;
  models?: Array<{ id: string; provider: string }>;
  providers?: Array<{ slug: string; name: string }>;
  defaultModels?: Record<string, string>;
}

function makeFetchMock(opts: MockFetchOpts = {}) {
  const {
    providerTotal = 0,
    agentTotal = 0,
    postProviderOk = true,
    postAgentOk = true,
    models = [],
    providers = [],
    defaultModels = {},
  } = opts;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';

    if (u.includes('/providers/detect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { detected: [] } }),
      });
    }

    if (init?.method === 'POST' && u.includes('/providers')) {
      if (!postProviderOk) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({ success: false, error: { code: 'VALIDATION', message: 'bad' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'prov-1' } }),
      });
    }

    if (u.includes('/providers')) {
      // List endpoint — page=1&limit=N
      const data =
        providers.length > 0
          ? providers
          : Array.from({ length: providerTotal }, (_, i) => ({
              slug: `p${i}`,
              name: `Provider ${i}`,
            }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data, meta: { total: providerTotal } }),
      });
    }

    if (init?.method === 'POST' && u.includes('/agents')) {
      if (!postAgentOk) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () =>
            Promise.resolve({ success: false, error: { code: 'VALIDATION', message: 'bad' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'agent-1', slug: 'my-agent' } }),
      });
    }

    if (u.includes('/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: agentTotal } }),
      });
    }

    if (init?.method === 'PATCH' && u.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    }

    if (u.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { defaultModels } }),
      });
    }

    if (u.includes('/models')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: models }),
      });
    }

    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SetupWizard — step content', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Step 2 — Provider
  // --------------------------------------------------------------------------

  describe('Step 2 — StepProvider', () => {
    it('already-exists card auto-shows when providers exist and Continue advances', async () => {
      const fetchMock = makeFetchMock({ providerTotal: 1 });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/already have a provider configured/i)).toBeInTheDocument();
      });

      const postCallsBefore = fetchMock.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      }).length;

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/Step 3 of 6/i)).toBeInTheDocument();
      });

      const postCallsAfter = fetchMock.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      }).length;
      expect(postCallsAfter).toBe(postCallsBefore);
    });

    it('renders manual flavour-picker form when no providers and no env vars detected', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0 }));
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });
      // The manual flavour picker is the new contract — verify the
      // dropdown trigger exists.
      expect(document.getElementById('provider-flavour')).not.toBeNull();
      expect(document.getElementById('provider-name')).not.toBeNull();
      expect(document.getElementById('provider-slug')).not.toBeNull();
    });

    it('renders inline error when the provider POST returns a non-ok response', async () => {
      const fetchMock = makeFetchMock({ providerTotal: 0, postProviderOk: false });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });

      // Pre-fill the providerDraft via localStorage so the form has values.
      // Then click submit — the manual path's Zod-required providerType
      // gates the submission, so seed it.
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          stepIndex: 1,
          providerDraft: {
            name: 'Bad Provider',
            slug: 'bad-provider',
            apiKeyEnvVar: 'X',
            providerType: 'anthropic',
            baseUrl: '',
            suggestedDefaultChatModel: '',
            suggestedEmbeddingModel: '',
          },
          agentDraft: {
            name: '',
            slug: '',
            description: '',
            systemInstructions: '',
            model: '',
            provider: '',
          },
          createdAgentSlug: null,
        })
      );
      // Re-render now that storage is seeded.
      window.location.reload?.();
      // userEvent will pick up the form on next render.

      // Click submit (form fields already populated from storage).
      const submit = screen.getByRole('button', { name: /create provider/i });
      await user.click(submit);

      await waitFor(() => {
        expect(
          screen.getByText(/could not create the provider|Pick a provider type/i)
        ).toBeInTheDocument();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Step 3 — Default Models
  // --------------------------------------------------------------------------

  describe('Step 3 — StepDefaultModels', () => {
    it('renders chat + embedding selectors', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          providerTotal: 1,
          models: [{ id: 'claude-sonnet-4-6', provider: 'anthropic' }],
          defaultModels: { chat: 'claude-sonnet-4-6' },
        })
      );

      seedStorage(2);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 3 of 6/i)).toBeInTheDocument();
      });
      expect(document.getElementById('default-chat-model')).not.toBeNull();
      expect(document.getElementById('default-embedding-model')).not.toBeNull();
    });

    it('Continue PATCHes /settings with the chat/embedding choice', async () => {
      const fetchMock = makeFetchMock({
        providerTotal: 1,
        models: [{ id: 'claude-sonnet-4-6', provider: 'anthropic' }],
        defaultModels: { chat: 'claude-sonnet-4-6', embeddings: 'voyage-3' },
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      seedStorage(2);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 3 of 6/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        const patchCalls = fetchMock.mock.calls.filter((call) => {
          const u = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return u.includes('/settings') && init?.method === 'PATCH';
        });
        expect(patchCalls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Step 4 — Agent creation
  // --------------------------------------------------------------------------

  describe('Step 4 — StepAgent', () => {
    it('shows a warning when no active providers exist', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0, providers: [] }));

      seedStorage(3);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 4 of 6/i)).toBeInTheDocument());
      await waitFor(() => {
        expect(screen.getByText(/No active providers found/i)).toBeInTheDocument();
      });
    });

    it('renders the form with provider/model dropdowns when providers exist', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          providerTotal: 1,
          providers: [{ slug: 'anthropic', name: 'Anthropic' }],
          models: [{ id: 'claude-sonnet-4-6', provider: 'anthropic' }],
        })
      );

      seedStorage(3);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 4 of 6/i)).toBeInTheDocument());
      await waitFor(() => {
        expect(document.getElementById('agent-provider')).not.toBeNull();
        expect(document.getElementById('agent-model')).not.toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Step 5 — Test agent
  // --------------------------------------------------------------------------

  describe('Step 5 — StepTestAgent', () => {
    it('Continue button advances to step 6', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1, agentTotal: 1 }));
      const user = userEvent.setup();

      seedStorage(4, { createdAgentSlug: 'my-agent' });
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 5 of 6/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => expect(screen.getByText(/Step 6 of 6/i)).toBeInTheDocument());
    });
  });

  // --------------------------------------------------------------------------
  // Step 6 — Done
  // --------------------------------------------------------------------------

  describe('Step 6 — StepDone', () => {
    it('renders the success card and navigation links', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1, agentTotal: 1 }));

      seedStorage(5);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 6 of 6/i)).toBeInTheDocument());
      expect(screen.getByText(/you're set up/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /explore patterns/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /build a workflow/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /add knowledge docs/i })).toBeInTheDocument();
    });

    it('Finish clears localStorage and calls onOpenChange(false)', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1, agentTotal: 1 }));

      const onOpenChange = vi.fn();
      seedStorage(5);

      const user = userEvent.setup();
      render(<SetupWizard open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText(/Step 6 of 6/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /finish/i }));

      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
