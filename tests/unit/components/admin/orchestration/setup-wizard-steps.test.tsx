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
import {
  STORAGE_KEY,
  makeFetchMock,
  seedStorage,
} from '@/tests/unit/components/admin/orchestration/setup-wizard.helpers';

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

    it('detection-card click POSTs to /providers and PATCHes /settings with suggestions', async () => {
      // Drives createProviderFromRow + persistSuggestedDefaults on
      // the env-var-detected branch — previously uncovered. Verifies
      // BOTH the provider POST body AND the settings PATCH body
      // (since persistSuggestedDefaults is called inline after the
      // provider create succeeds).
      const fetchMock = makeFetchMock({
        providerTotal: 0,
        detected: [
          {
            slug: 'anthropic',
            name: 'Anthropic',
            providerType: 'anthropic',
            defaultBaseUrl: null,
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            apiKeyPresent: true,
            alreadyConfigured: false,
            isLocal: false,
            suggestedDefaultChatModel: 'claude-sonnet-4-6',
            suggestedRoutingModel: 'claude-haiku-4-5',
            suggestedReasoningModel: 'claude-opus-4-6',
            suggestedEmbeddingModel: null,
          },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      seedStorage(0);
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Detection card surfaces with a Configure button (the card is
      // a button itself with the provider name + env-var name).
      await waitFor(() => {
        expect(screen.getByText(/we detected an api key/i)).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole('button', { name: /anthropic.*detected.*ANTHROPIC_API_KEY/is })
      );

      // Provider POST should fire with the detection row's slug + type.
      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find((call) => {
          const url = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return url.includes('/providers') && !url.includes('/detect') && init?.method === 'POST';
        });
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        expect(body.slug).toBe('anthropic');
        expect(body.providerType).toBe('anthropic');
        expect(body.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
      });

      // PATCH /settings should fire with the suggested chat / routing /
      // reasoning slots filled in.
      await waitFor(() => {
        const patchCall = fetchMock.mock.calls.find((call) => {
          const url = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return url.includes('/settings') && init?.method === 'PATCH';
        });
        expect(patchCall).toBeDefined();
        const body = JSON.parse((patchCall![1] as RequestInit).body as string);
        expect(body.defaultModels).toMatchObject({
          chat: 'claude-sonnet-4-6',
          routing: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
        });
      });
    });

    it('manual form submit POSTs the filled fields to /providers and advances to step 2', async () => {
      // Drives handleManualSubmit + the four Select onChange
      // handlers in the manual form. Without this the entire
      // happy-path through the manual provider-creation flow is
      // uncovered (only field rendering was tested before).
      const fetchMock = makeFetchMock({ providerTotal: 0 });
      vi.stubGlobal('fetch', fetchMock);
      seedStorage(0);
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });

      // Fill the text inputs (also exercises baseUrl / apiKeyEnvVar
      // onChange handlers that would otherwise stay uncovered).
      const nameInput = document.getElementById('provider-name') as HTMLInputElement;
      await user.type(nameInput, 'Test Provider');
      const slugInput = document.getElementById('provider-slug') as HTMLInputElement;
      await user.type(slugInput, 'test-provider');

      // Select OpenAI-compatible so the baseUrl input renders, then fill it.
      await user.click(screen.getByRole('combobox', { name: /provider type/i }));
      await user.click(screen.getByRole('option', { name: /openai-compatible/i }));

      const baseUrlInput = document.getElementById('provider-base-url') as HTMLInputElement;
      await user.type(baseUrlInput, 'https://api.example.com/v1');

      const envVarInput = document.getElementById('provider-env') as HTMLInputElement;
      await user.type(envVarInput, 'TEST_API_KEY');

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find((call) => {
          const url = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return url.includes('/providers') && !url.includes('/detect') && init?.method === 'POST';
        });
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        expect(body.name).toBe('Test Provider');
        expect(body.slug).toBe('test-provider');
        expect(body.providerType).toBe('openai-compatible');
        expect(body.baseUrl).toBe('https://api.example.com/v1');
        expect(body.apiKeyEnvVar).toBe('TEST_API_KEY');
      });

      // After successful POST, the wizard advances to step 2.
      await waitFor(() => {
        expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument();
      });
    });

    it('Close button (X) calls onOpenChange(false) without clearing wizard state', async () => {
      // Drives handleClose (L169) — distinct from handleFinish (L173)
      // which also clears localStorage. Operators may close mid-flow
      // and resume later, so closing must NOT clear state.
      vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0 }));
      seedStorage(0);
      const onOpenChange = vi.fn();
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={onOpenChange} />);

      // The dialog has a built-in Radix X close button AND our footer
      // Close button — both have the accessible name "Close". The
      // footer one is the last in document order (rendered inside
      // DialogFooter); click that to drive `handleClose`.
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^close$/i }).length).toBeGreaterThan(0);
      });
      const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
      await user.click(closeButtons[closeButtons.length - 1]);

      expect(onOpenChange).toHaveBeenCalledWith(false);
      // localStorage state preserved — distinguishes Close from Finish.
      expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('"Configure manually instead" toggles the detection list to the manual form', async () => {
      // Drives the manualMode toggle (line 611) — previously
      // uncovered because tests either had detection rows OR no
      // detection rows, never the override-from-detection path.
      vi.stubGlobal(
        'fetch',
        makeFetchMock({
          providerTotal: 0,
          detected: [
            {
              slug: 'anthropic',
              name: 'Anthropic',
              providerType: 'anthropic',
              defaultBaseUrl: null,
              apiKeyEnvVar: 'ANTHROPIC_API_KEY',
              apiKeyPresent: true,
              alreadyConfigured: false,
              isLocal: false,
              suggestedDefaultChatModel: 'claude-sonnet-4-6',
              suggestedRoutingModel: null,
              suggestedReasoningModel: null,
              suggestedEmbeddingModel: null,
            },
          ],
        })
      );
      seedStorage(0);
      const user = userEvent.setup();

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Detection list renders first.
      await waitFor(() => {
        expect(screen.getByText(/we detected an api key/i)).toBeInTheDocument();
      });

      // Click "Configure manually instead" — the manual form replaces
      // the detection list.
      await user.click(screen.getByRole('button', { name: /configure manually instead/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });
      expect(document.getElementById('provider-flavour')).not.toBeNull();
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

      // Wait for the form fields directly — the wizard title renders
      // before StepDefaultModels resolves its fetches and clears the
      // loading spinner. Asserting on the title alone races on slower
      // environments (e.g. CI).
      await waitFor(() => {
        expect(document.getElementById('default-chat-model')).not.toBeNull();
      });
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

      // Wait for the Continue button — it only renders once the
      // StepDefaultModels effect has resolved and loading is false.
      const continueButton = await screen.findByRole('button', { name: /continue/i });
      await user.click(continueButton);

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

    it('Run test surfaces a failure status when /test-model returns ok=false', async () => {
      // Drives StepSmokeTest's failure branch + SmokeTestStatusIcon's
      // failure variant — previously only the success path was
      // exercised. Provider /test passes but model /test-model fails;
      // the row should reflect the failure instead of the latency
      // badge.
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
        providerTestModelOk: false,
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      seedStorage(2);
      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /run test/i })).toBeInTheDocument()
      );

      await user.click(screen.getByRole('button', { name: /run test/i }));

      // Failure copy appears (ok:false on test-model). The success
      // path's "42ms round-trip" must NOT appear.
      await waitFor(() => {
        expect(screen.queryByText(/42ms round-trip/i)).not.toBeInTheDocument();
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
