/**
 * SetupWizard — Individual Step Content Tests
 *
 * Drills into per-step API interactions in the new 4-step layout:
 *   Step 1 (index 0) — StepProvider: detection, manual form, error path
 *   Step 2 (index 1) — StepDefaultModels: renders, persists chat/embedding choice
 *   Step 3 (index 2) — StepSmokeTest: lists providers, runs test+test-model
 *   Step 4 (index 3) — StepDone: renders, Finish clears localStorage
 *
 * @see components/admin/orchestration/setup-wizard.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v3';

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
      ...overrides,
    })
  );
}

interface MockFetchOpts {
  providerTotal?: number;
  postProviderOk?: boolean;
  models?: Array<{ id: string; provider: string }>;
  /** Rows returned by GET /providers (full list, not just paginated count). */
  providers?: Array<{
    id: string;
    slug: string;
    name: string;
    isLocal?: boolean;
    apiKeyPresent?: boolean;
  }>;
  defaultModels?: Record<string, string>;
  /** Result returned by POST /providers/:id/test. */
  providerTestOk?: boolean;
  /** Result returned by POST /providers/:id/test-model. */
  providerTestModelOk?: boolean;
}

function makeFetchMock(opts: MockFetchOpts = {}) {
  const {
    providerTotal = 0,
    postProviderOk = true,
    models = [],
    providers = [],
    defaultModels = {},
    providerTestOk = true,
    providerTestModelOk = true,
  } = opts;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';

    if (u.includes('/providers/detect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { detected: [] } }),
      });
    }

    if (u.match(/\/providers\/[^/]+\/test-model/) && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { ok: providerTestModelOk, latencyMs: 42 } }),
      });
    }

    if (u.match(/\/providers\/[^/]+\/test/) && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { ok: providerTestOk } }),
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
      const data =
        providers.length > 0
          ? providers
          : Array.from({ length: providerTotal }, (_, i) => ({
              id: `id-${i}`,
              slug: `p${i}`,
              name: `Provider ${i}`,
              isLocal: false,
              apiKeyPresent: true,
            }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data, meta: { total: providerTotal } }),
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
  // Step 1 — Provider
  // --------------------------------------------------------------------------

  describe('Step 1 — StepProvider', () => {
    it('already-exists card auto-shows when providers exist and Continue advances', async () => {
      const fetchMock = makeFetchMock({ providerTotal: 1 });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      seedStorage(0);

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
        expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument();
      });

      const postCallsAfter = fetchMock.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      }).length;
      expect(postCallsAfter).toBe(postCallsBefore);
    });

    it('renders manual flavour-picker form when no providers and no env vars detected', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0 }));
      seedStorage(0);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });
      expect(document.getElementById('provider-flavour')).not.toBeNull();
      expect(document.getElementById('provider-name')).not.toBeNull();
      expect(document.getElementById('provider-slug')).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Step 2 — Default Models
  // --------------------------------------------------------------------------

  describe('Step 2 — StepDefaultModels', () => {
    it('renders chat + embedding selectors', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          providerTotal: 1,
          models: [{ id: 'claude-sonnet-4-6', provider: 'anthropic' }],
          defaultModels: { chat: 'claude-sonnet-4-6' },
        })
      );

      seedStorage(1);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument();
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

      seedStorage(1);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument());

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
  // Step 3 — Smoke test
  // --------------------------------------------------------------------------

  describe('Step 3 — StepSmokeTest', () => {
    it('renders one row per active provider with a Run test button', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          providerTotal: 1,
          providers: [
            {
              id: 'prov-1',
              slug: 'anthropic',
              name: 'Anthropic',
              apiKeyPresent: true,
              isLocal: false,
            },
          ],
          defaultModels: { chat: 'claude-sonnet-4-6' },
        })
      );

      seedStorage(2);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 3 of 4/i)).toBeInTheDocument());
      await waitFor(() => {
        expect(screen.getByText('Anthropic')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument();
      });
    });

    it('Run test calls POST /providers/:id/test then POST /providers/:id/test-model', async () => {
      const fetchMock = makeFetchMock({
        providerTotal: 1,
        providers: [
          {
            id: 'prov-1',
            slug: 'anthropic',
            name: 'Anthropic',
            apiKeyPresent: true,
            isLocal: false,
          },
        ],
        defaultModels: { chat: 'claude-sonnet-4-6' },
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      seedStorage(2);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument()
      );

      await user.click(screen.getByRole('button', { name: /run test/i }));

      await waitFor(() => {
        const postUrls = fetchMock.mock.calls
          .filter((call) => {
            const init = call[1] as RequestInit | undefined;
            return init?.method === 'POST';
          })
          .map((call) => (typeof call[0] === 'string' ? call[0] : ''));
        // Both the connectivity test (POST /providers/:id/test) AND the
        // model-level test (POST /providers/:id/test-model) must fire —
        // a count-only assertion would also pass if the same endpoint
        // was hit twice or an unrelated endpoint slipped in.
        expect(postUrls.some((u) => u.includes('/providers/prov-1/test-model'))).toBe(true);
        expect(
          postUrls.some((u) => u.includes('/providers/prov-1/test') && !u.includes('/test-model'))
        ).toBe(true);
      });

      // Latency badge appears on success.
      await waitFor(() => {
        expect(screen.getByText(/42ms round-trip/i)).toBeInTheDocument();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Step 4 — Done
  // --------------------------------------------------------------------------

  describe('Step 4 — StepDone', () => {
    it('renders the success card and navigation links', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1 }));

      seedStorage(3);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => expect(screen.getByText(/Step 4 of 4/i)).toBeInTheDocument());
      expect(screen.getByText(/you're set up/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /explore patterns/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /build a workflow/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /add knowledge docs/i })).toBeInTheDocument();
    });

    it('Finish clears localStorage and calls onOpenChange(false)', async () => {
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1 }));

      const onOpenChange = vi.fn();
      seedStorage(3);

      const user = userEvent.setup();
      render(<SetupWizard open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => expect(screen.getByText(/Step 4 of 4/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /finish/i }));

      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
